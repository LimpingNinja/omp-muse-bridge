import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
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
	totalTokens: 0,
	cost: 0,
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

/** Create a private prompt file, removing the directory if its write fails. */
async function writeMusePrompt(prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-muse-"));
	const filePath = path.join(dir, "prompt.md");
	try {
		// mkdtemp guarantees a unique path; mode 0o600 keeps the prompt private.
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
	} catch (writeError) {
		let cleanupError: unknown;
		try {
			await fs.promises.rm(dir, { recursive: true, force: true });
		} catch (error) {
			cleanupError = error;
		}
		if (cleanupError === undefined) throw writeError;
		throw new AggregateError([writeError, cleanupError], "Muse prompt write failed and its cleanup failed");
	}
	return { dir, filePath };
}

/** Preserve absent usage fields, accept zero counters, and keep totals separate from context occupancy. */
function readUsage(record: Record<string, unknown>, current: MuseUsage): MuseUsage {
	const nested = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
		? record.usage as Record<string, unknown>
		: record;
	const pick = (...keys: string[]): number | undefined => {
		for (const key of keys) {
			const value = nested[key];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
		}
		return undefined;
	};
	const cacheRead = pick("cache_read_tokens", "cached_tokens", "cacheRead");
	const cacheWrite = pick("cache_write_tokens", "cacheWrite");
	const promptTotal = pick("prompt_tokens", "promptTokens");
	const inputFromPromptTotal = promptTotal === undefined
		? undefined
		: Math.max(0, promptTotal - (cacheRead ?? current.cacheRead) - (cacheWrite ?? current.cacheWrite));
	const input = inputFromPromptTotal ?? pick("input_tokens", "input");
	const output = pick("output_tokens", "output");
	const contextTokens = pick("context_tokens", "contextTokens");
	const serverTotal = pick("total_tokens", "totalTokens");
	const cost = pick("cost", "cost_total");
	const turns = pick("turns");
	const countersChanged = input !== undefined || output !== undefined || cacheRead !== undefined || cacheWrite !== undefined;
	if (!countersChanged && serverTotal === undefined && contextTokens === undefined && cost === undefined && turns === undefined) return current;
	const merged: MuseUsage = {
		input: input ?? current.input,
		output: output ?? current.output,
		cacheRead: cacheRead ?? current.cacheRead,
		cacheWrite: cacheWrite ?? current.cacheWrite,
		totalTokens: 0,
		cost: cost ?? current.cost,
		contextTokens: contextTokens ?? current.contextTokens,
		turns: turns ?? current.turns,
	};
	merged.totalTokens = serverTotal ?? (countersChanged ? merged.input + merged.output + merged.cacheRead + merged.cacheWrite : current.totalTokens);
	return merged;
}

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		throw error;
	}
}

/** Stop only the spawned process tree and await escalation even if its leader exits first. */
async function stopProcessTree(child: ChildProcess): Promise<void> {
	if (child.pid === undefined) return;
	const pid = child.pid;
	if (process.platform === "win32") {
		await new Promise<void>((resolve, reject) => {
			const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { shell: false, stdio: "ignore" });
			killer.once("error", reject);
			killer.once("close", (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with code ${code}`)));
		});
		return;
	}
	const signal = (value: NodeJS.Signals) => {
		try {
			process.kill(-pid, value);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	signal("SIGTERM");
	const grace = Date.now() + 5_000;
	while (processGroupExists(pid) && Date.now() < grace) await delay(50);
	if (!processGroupExists(pid)) return;
	signal("SIGKILL");
	const confirmation = Date.now() + 1_000;
	while (processGroupExists(pid) && Date.now() < confirmation) await delay(50);
	if (processGroupExists(pid)) throw new Error("Muse process-group termination could not be confirmed");
}

/** Run the headless exec transport and clean up its prompt and cancellation resources. */
export async function runMuse(request: MuseRunRequest): Promise<MuseRunResult> {
	if (request.signal?.aborted) throw new Error("Muse run was aborted");
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
	let cancellationError: unknown;

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
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			let buffer = "";
			let closed = false;
			let closeCode = 1;
			let cancellationPending = false;
			const finishClose = () => {
				if (closed && !cancellationPending) resolve(closeCode);
			};

			const processLine = (line: string) => {
				if (!line.trim() || line.startsWith("muse:")) return;
				let decoded: unknown;
				try {
					decoded = JSON.parse(line);
				} catch (error) {
					if (line.trimStart().startsWith("{")) {
						diagnostics.push(`Failed to parse Muse JSON: ${errorMessage(error)} — ${line.slice(0, 200)}`);
					}
					return;
				}
				if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
					diagnostics.push("Muse sent a non-object exec event; ignoring it");
					return;
				}
				const event = decoded as Record<string, unknown>;
				const eventSessionId = event.stream && typeof event.stream === "object"
					? (event.stream as Record<string, unknown>).id
					: undefined;
				if (typeof eventSessionId === "string") resultSessionId = eventSessionId;
				const payloadType = typeof event.payload_type === "string" ? event.payload_type : "";
				const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
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

			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});

			const abort = () => {
				if (wasAborted) return;
				wasAborted = true;
				cancellationPending = true;
				void stopProcessTree(child).catch((error: unknown) => {
					cancellationError = error;
				}).finally(() => {
					cancellationPending = false;
					finishClose();
				});
			};
			if (request.signal?.aborted) abort();
			else request.signal?.addEventListener("abort", abort, { once: true });

			child.on("error", (error) => {
				stderr += `${stderr ? "\n" : ""}Failed to spawn muse: ${error.message}`;
			});
			child.on("close", (code) => {
				closed = true;
				closeCode = code ?? 1;
				request.signal?.removeEventListener("abort", abort);
				if (buffer.trim()) processLine(buffer);
				finishClose();
			});
		});

		if (wasAborted) {
			throw new Error(cancellationError === undefined
				? "Muse run was aborted"
				: `Muse abort requested; process-tree cleanup failed: ${errorMessage(cancellationError)}`);
		}
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
