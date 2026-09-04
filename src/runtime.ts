import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { resolveMuseModelId } from "./catalog.ts";
import { errorMessage } from "./utils.ts";

export { type MuseThinkingLevel, type MuseUsage } from "./contracts.ts";
import { museThinkingLevel, type MuseThinkingLevel, type MuseUsage } from "./contracts.ts";

export interface MuseRunRequest {
	prompt: string;
	cwd: string;
	model?: string;
	sessionId?: string;
	thinkingLevel?: MuseThinkingLevel;
	yolo?: boolean;
	signal?: AbortSignal;
	onTextDelta?: (delta: string) => void;
}

export interface MuseRunResult {
	exitCode: number;
	output: string;
	stderr: string;
	diagnostics: string[];
	usage: MuseUsage;
	model: string;
	sessionId?: string;
	errorMessage?: string;
}

const EMPTY_USAGE: MuseUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

export { museThinkingLevel };

export function getMuseExecArgs(
	promptFile: string,
	workspace: string,
	modelId: string,
	yolo = true,
	thinkingLevel?: MuseThinkingLevel,
	sessionId?: string,
): string[] {
	const args = ["exec", "--json", "--prompt-file", promptFile, "--workspace", workspace, "--user-input-auto-resolve"];
	if (sessionId) args.push("--session-id", sessionId);
	if (yolo) args.push("--yolo");
	else args.push("--trust-workspace", "--disable-approval");
	const museThinking = museThinkingLevel(thinkingLevel);
	if (museThinking) args.push("--reasoning-effort", museThinking);
	args.push("--model", modelId);
	return args;
}

export function getBundledAgentPath(): string {
	return fileURLToPath(new URL("../agents/muse-spark.md", import.meta.url));
}

export function loadMuseSystemPrompt(): string {
	const filePath = getBundledAgentPath();
	const { frontmatter, body } = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
	const meta = frontmatter as Record<string, unknown>;
	if (meta.name !== "muse-spark" || !meta.description || !body.trim()) {
		throw new Error(`Invalid bundled Muse agent definition: ${filePath}`);
	}
	return body.trim();
}

async function writeMusePrompt(prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-muse-"));
	const filePath = path.join(dir, "prompt.md");
	// OMP lacks upstream's withFileMutationQueue; mkdtemp already guarantees a unique path,
	// so a plain write is safe. mode 0o600 keeps the prompt private.
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

function numeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readUsage(payload: unknown, current: MuseUsage): MuseUsage {
	if (!payload || typeof payload !== "object") return current;
	const record = payload as Record<string, unknown>;
	const nested = record.usage && typeof record.usage === "object"
		? record.usage as Record<string, unknown>
		: record;
	return {
		input: numeric(nested.input_tokens ?? nested.input) || current.input,
		output: numeric(nested.output_tokens ?? nested.output) || current.output,
		cacheRead: numeric(nested.cache_read_tokens ?? nested.cached_tokens ?? nested.cacheRead) || current.cacheRead,
		cacheWrite: numeric(nested.cache_write_tokens ?? nested.cacheWrite) || current.cacheWrite,
		cost: numeric(nested.cost ?? nested.cost_total) || current.cost,
		contextTokens: numeric(nested.context_tokens ?? nested.total_tokens ?? nested.contextTokens) || current.contextTokens,
		turns: numeric(nested.turns) || current.turns,
	};
}

export async function runMuse(request: MuseRunRequest): Promise<MuseRunResult> {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(request.cwd);
	} catch (error) {
		throw new Error(`Muse workspace is unavailable: ${request.cwd}: ${errorMessage(error)}`);
	}
	if (!stat.isDirectory()) throw new Error(`Muse workspace is not a directory: ${request.cwd}`);

	const model = resolveMuseModelId(request.model);
	const temporary = await writeMusePrompt(request.prompt);
	let stderr = "";
	let streamedOutput = "";
	let terminalOutput: string | undefined;
	let terminalError: string | undefined;
	let configuredModel = model;
	let usage = { ...EMPTY_USAGE };
	let wasAborted = false;
	let resultSessionId = request.sessionId;
	const diagnostics: string[] = [];
	let result: MuseRunResult | undefined;
	let executionError: unknown;

	try {
		const args = getMuseExecArgs(
			temporary.filePath,
			request.cwd,
			model,
			request.yolo !== false,
			request.thinkingLevel,
			request.sessionId,
		);
		const exitCode = await new Promise<number>((resolve) => {
			const useProcessGroup = process.platform !== "win32";
			const child = spawn(process.env.PI_MUSE_BINARY?.trim() || "muse", args, {
				cwd: request.cwd,
				detached: useProcessGroup,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let killTimer: NodeJS.Timeout | undefined;

			const processLine = (line: string) => {
				if (!line.trim() || line.startsWith("muse:")) return;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch (error) {
					if (line.trimStart().startsWith("{")) {
						diagnostics.push(`Failed to parse Muse JSON: ${errorMessage(error)} — ${line.slice(0, 200)}`);
					}
					return;
				}
				const eventSessionId = event.stream && typeof event.stream === "object"
					? (event.stream as Record<string, unknown>).id
					: undefined;
				if (typeof eventSessionId === "string") resultSessionId = eventSessionId;
				const payloadType = typeof event.payload_type === "string" ? event.payload_type : "";
				const payload = event.payload && typeof event.payload === "object"
					? event.payload as Record<string, unknown>
					: {};
				usage = readUsage(payload, usage);

				if (payloadType === "run.output.delta" && typeof payload.text === "string") {
					streamedOutput += payload.text;
					request.onTextDelta?.(payload.text);
				} else if (payloadType === "run.terminal.completed") {
					terminalOutput = typeof payload.text === "string" ? payload.text : streamedOutput;
				} else if (payloadType === "run.terminal.failed") {
					terminalOutput = typeof payload.text === "string" ? payload.text : streamedOutput;
					terminalError = typeof payload.reason === "string"
						? payload.reason
						: typeof payload.error === "string" ? payload.error : "Muse run failed";
				} else if (payloadType === "run.model.configured" && typeof payload.model_id === "string") {
					configuredModel = payload.model_id;
				}
			};

			child.stdout.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});

			const killTree = (signal: NodeJS.Signals) => {
				if (child.pid === undefined) return;
				try {
					if (useProcessGroup) process.kill(-child.pid, signal);
					else {
						const taskkillArgs = ["/pid", String(child.pid), "/t"];
						if (signal === "SIGKILL") taskkillArgs.push("/f");
						const killer = spawn("taskkill", taskkillArgs, { shell: false, stdio: "ignore" });
						killer.unref();
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
						diagnostics.push(`Failed to stop Muse process tree: ${errorMessage(error)}`);
					}
				}
			};
			const abort = () => {
				if (wasAborted) return;
				wasAborted = true;
				killTree("SIGTERM");
				killTimer = setTimeout(() => {
					killTree("SIGKILL");
				}, 5000);
			};
			if (request.signal?.aborted) abort();
			else request.signal?.addEventListener("abort", abort, { once: true });

			child.on("error", (error) => {
				stderr += `${stderr ? "\n" : ""}Failed to spawn muse: ${error.message}`;
			});
			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				if (killTimer) clearTimeout(killTimer);
				request.signal?.removeEventListener("abort", abort);
				resolve(code ?? 1);
			});
		});

		if (wasAborted) throw new Error("Muse run was aborted");
		const output = terminalOutput ?? streamedOutput;
		const failed = Boolean(terminalError) || exitCode !== 0;
		const failure = terminalError ?? (failed ? stderr.trim() || `Muse exited with code ${exitCode}` : undefined);
		result = {
			exitCode: failed ? exitCode || 1 : 0,
			output: output || (failure ? `Muse failed: ${failure}` : "(no output from Muse)"),
			stderr,
			diagnostics,
			usage,
			model: configuredModel,
			errorMessage: failure,
			sessionId: resultSessionId,
		};
	} catch (error) {
		executionError = error;
	}

	try {
		await fs.promises.rm(temporary.dir, { recursive: true, force: true });
	} catch (error) {
		const diagnostic = `Failed to clean up ${temporary.dir}: ${errorMessage(error)}`;
		if (result) result.diagnostics.push(diagnostic);
		else if (executionError !== undefined) {
			throw new AggregateError([executionError, error], `Muse execution and temporary-file cleanup both failed`);
		} else {
			throw error;
		}
	}

	if (executionError !== undefined) throw executionError;
	if (!result) throw new Error("Muse execution ended without a result");
	return result;
}
