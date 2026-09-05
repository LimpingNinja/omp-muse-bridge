import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getMuseCatalog, type MuseCatalogModel } from "./catalog.ts";
import { runMuse } from "./runtime.ts";
import { HostUnavailableError, type MuseTodoEntry, MuseSessionUnusableError, runMuseTurn, shutdownHost, steerActiveMuseRuns, uuidv7 } from "./msp.ts";
import { contextCheckpoint, prepareMuseContext, type MusePromptContext } from "./context.ts";
import { registerMusePlanDisplay } from "./plan.ts";
import { readMuseSession, writeMuseSession, type StoredMuseSession } from "./session-store.ts";
import type { MuseUsage } from "./contracts.ts";

const MUSE_API = "muse-code-cli" as Api;
const ALIAS_ID = "muse-spark";

const FALLBACK_MODEL: MuseCatalogModel = {
	id: ALIAS_ID,
	name: "Muse Spark",
	isDefault: true,
	isCurrent: true,
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function modelDefinition(model: MuseCatalogModel, id = model.id, name = model.name) {
	return {
		id,
		name,
		reasoning: true,
		thinkingLevelMap: { off: "off", xhigh: "xhigh", max: "max" },
		input: ["text"] as Array<"text" | "image">,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

export function getMuseProviderModels() {
	try {
		const catalog = getMuseCatalog();
		const defaultModel = catalog.models.find((model) => model.id === catalog.defaultId) ?? FALLBACK_MODEL;
		return [
			modelDefinition(defaultModel, ALIAS_ID, `Muse Spark (catalog default: ${defaultModel.id})`),
			...catalog.models
				.filter((model) => model.id !== ALIAS_ID)
				.map((model) => modelDefinition(model)),
		];
	} catch {
		// Registration remains available so execution can report missing Muse setup.
		return [modelDefinition(FALLBACK_MODEL)];
	}
}

interface MuseProviderSessionState extends Omit<StoredMuseSession, "updatedAt"> {
	ompSessionId: string;
	busy: boolean;
	closed: boolean;
	close(): void;
}

export interface MuseStreamSettings {
	sandboxed?: boolean;
	workspace?: string;
	onDiagnostic?: (message: string) => void;
	onTodoSnapshot?: (entries: MuseTodoEntry[]) => void;
}

async function persistSession(state: MuseProviderSessionState, diagnostic?: (message: string) => void): Promise<void> {
	if (state.closed) return;
	try {
		await writeMuseSession(state.ompSessionId, {
			sessionId: state.sessionId,
			initialized: state.initialized,
			checkpoint: state.checkpoint,
			systemPrompt: state.systemPrompt,
		});
	} catch (error) {
		diagnostic?.(`Muse session continuity could not be saved: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Reuse a backend only when its owner, instructions and committed OMP history still match. */
async function museSessionState(
	options: SimpleStreamOptions | undefined,
	prepared: MusePromptContext,
	diagnostic?: (message: string) => void,
): Promise<MuseProviderSessionState | undefined> {
	if (!options?.sessionId || !options.providerSessionState) return undefined;
	let state = options.providerSessionState.get(MUSE_API) as MuseProviderSessionState | undefined;
	if (state && (state.closed || state.ompSessionId !== options.sessionId)) {
		options.providerSessionState.delete(MUSE_API);
		state = undefined;
	}
	if (state?.busy) throw new Error("This OMP session already has an active Muse request");
	if (!state) {
		state = {
			ompSessionId: options.sessionId,
			sessionId: uuidv7(),
			initialized: false,
			checkpoint: prepared.checkpoint,
			systemPrompt: prepared.systemPrompt,
			busy: true,
			closed: false,
			close() { this.closed = true; },
		};
		options.providerSessionState.set(MUSE_API, state);
		try {
			const remembered = await readMuseSession(options.sessionId);
			if (remembered) Object.assign(state, remembered);
		} catch (error) {
			diagnostic?.(`Muse session continuity could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		state.busy = true;
	}
	if (state.checkpoint !== prepared.checkpoint || state.systemPrompt !== prepared.systemPrompt) {
		state.sessionId = uuidv7();
		state.initialized = false;
		diagnostic?.("OMP context changed; seeding a new Muse session from the current conversation");
	}
	state.systemPrompt = prepared.systemPrompt;
	// An interrupted process must not leave a checkpoint claiming unfinished work was committed.
	state.checkpoint = undefined;
	await persistSession(state, diagnostic);
	return state;
}

function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Adapt a Muse-owned run to OMP's assistant stream without exposing native tool calls. */
export function streamMuse(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	settings: MuseStreamSettings = {},
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = emptyMessage(model);
	const diagnostic = settings.onDiagnostic;

	void (async () => {
		let sessionState: MuseProviderSessionState | undefined;
		// Release before publishing a terminal; later continuations must not unlock a successor's request.
		const releaseSession = () => {
			if (!sessionState) return;
			sessionState.busy = false;
			sessionState = undefined;
		};
		let openBlock: { type: "text" | "thinking"; index: number; itemId?: string } | undefined;
		const itemBlocks = new Map<string, number[]>();

		const closeOpenBlock = () => {
			const current = openBlock;
			if (!current) return;
			const block = output.content[current.index];
			if (current.type === "text" && block?.type === "text") {
				stream.push({ type: "text_end", contentIndex: current.index, content: block.text, partial: output });
			} else if (current.type === "thinking" && block?.type === "thinking") {
				stream.push({ type: "thinking_end", contentIndex: current.index, content: block.thinking, partial: output });
			}
			openBlock = undefined;
		};

		const pushTextDelta = (delta: string, itemId = "exec") => {
			if (!delta) return;
			if (openBlock?.type !== "text" || openBlock.itemId !== itemId) {
				closeOpenBlock();
				const index = output.content.length;
				output.content.push({ type: "text", text: "" });
				openBlock = { type: "text", index, itemId };
				const indices = itemBlocks.get(itemId) ?? [];
				indices.push(index);
				itemBlocks.set(itemId, indices);
				stream.push({ type: "text_start", contentIndex: index, partial: output });
			}
			const block = output.content[openBlock.index];
			if (block.type !== "text") return;
			block.text += delta;
			stream.push({ type: "text_delta", contentIndex: openBlock.index, delta, partial: output });
		};

		const replaceTextBlocks = (indices: number[], text: string) => {
			closeOpenBlock();
			for (let position = 0; position < indices.length; position++) {
				const index = indices[position];
				const block = output.content[index];
				if (block.type !== "text") continue;
				block.text = position === 0 ? text : "";
				stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			}
		};

		const reconcileItem = (itemId: string, text: string) => {
			const indices = itemBlocks.get(itemId) ?? [];
			const partial = indices.map((index) => {
				const block = output.content[index];
				return block.type === "text" ? block.text : "";
			}).join("");
			if (partial === text) return;
			if (text.startsWith(partial)) pushTextDelta(text.slice(partial.length), itemId);
			else replaceTextBlocks(indices, text);
		};

		const reconcileFinalText = (text: string) => {
			const indices: number[] = [];
			let partial = "";
			for (let index = 0; index < output.content.length; index++) {
				const block = output.content[index];
				if (block.type !== "text") continue;
				indices.push(index);
				partial += block.text;
			}
			if (partial === text) return;
			if (text.startsWith(partial)) pushTextDelta(text.slice(partial.length), "terminal");
			else replaceTextBlocks(indices, text);
		};

		const pushThinkingDelta = (delta: string) => {
			if (!delta) return;
			if (openBlock?.type !== "thinking") {
				closeOpenBlock();
				const index = output.content.length;
				output.content.push({ type: "thinking", thinking: "" });
				openBlock = { type: "thinking", index };
				stream.push({ type: "thinking_start", contentIndex: index, partial: output });
			}
			const block = output.content[openBlock.index];
			if (block.type !== "thinking") return;
			block.thinking += delta;
			stream.push({ type: "thinking_delta", contentIndex: openBlock.index, delta, partial: output });
		};

		const setUsage = (usage: MuseUsage) => {
			output.usage.input = usage.input;
			output.usage.output = usage.output;
			output.usage.cacheRead = usage.cacheRead;
			output.usage.cacheWrite = usage.cacheWrite;
			output.usage.totalTokens = usage.totalTokens;
			calculateCost(model, output.usage);
			if (usage.contextTokens !== undefined) {
				output.contextSnapshot = { promptTokens: usage.contextTokens, nonMessageTokens: 0 };
			}
		};

		const finish = async () => {
			closeOpenBlock();
			output.stopReason = "stop";
			if (sessionState) {
				sessionState.initialized = true;
				sessionState.checkpoint = contextCheckpoint(context.messages, context.messages.length, output);
				await persistSession(sessionState, diagnostic);
			}
			releaseSession();
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		};

		try {
			stream.push({ type: "start", partial: output });
			if (options?.signal?.aborted) throw new Error("Muse turn was interrupted");
			const workspace = settings.workspace ?? process.cwd();
			const prepared = prepareMuseContext(context, workspace);
			sessionState = await museSessionState(options, prepared, diagnostic);
			const thinkingLevel = options?.disableReasoning ? "off" : options?.reasoning;
			if (sessionState) {
				try {
					const runTurn = () => runMuseTurn({
						sessionId: sessionState!.sessionId,
						resumeExisting: sessionState!.initialized,
						prompt: prepared.task,
						initialPrompt: prepared.initialPrompt,
						modelId: model.id,
						workspace,
						thinkingLevel,
						sandboxed: settings.sandboxed === true,
						signal: options?.signal,
						onTextDelta: pushTextDelta,
						onTextSnapshot: reconcileItem,
						onReasoningDelta: options?.hideThinkingSummary ? undefined : pushThinkingDelta,
						onActivityDelta: pushThinkingDelta,
						onTodoSnapshot: settings.onTodoSnapshot,
					});
					let outcome: Awaited<ReturnType<typeof runMuseTurn>>;
					try {
						outcome = await runTurn();
					} catch (error) {
						if (!(error instanceof MuseSessionUnusableError)) throw error;
						diagnostic?.(`${error.message}; seeding a replacement Muse session`);
						sessionState.sessionId = uuidv7();
						sessionState.initialized = false;
						await persistSession(sessionState, diagnostic);
						outcome = await runTurn();
					}
					for (const message of outcome.diagnostics) diagnostic?.(message);
					reconcileFinalText(outcome.output || (outcome.errorMessage ? "" : "(no output from Muse)"));
					setUsage(outcome.usage);
					if (outcome.errorMessage) {
						if (outcome.aborted) output.stopReason = "aborted";
						throw new Error(outcome.errorMessage);
					}
					await finish();
					return;
				} catch (error) {
					if (!(error instanceof HostUnavailableError) || options?.signal?.aborted) throw error;
					diagnostic?.(`Muse host unavailable (${error.message}); using exec fallback`);
					pushThinkingDelta("[Muse] Host unavailable; using exec fallback without live activity, steering or todo updates.\n");
				}
			}
			if (options?.signal?.aborted) throw new Error("Muse turn was interrupted");
			const result = await runMuse({
				prompt: sessionState?.initialized ? prepared.task : prepared.initialPrompt(),
				cwd: workspace,
				model: model.id,
				thinkingLevel,
				yolo: settings.sandboxed !== true,
				signal: options?.signal,
				sessionId: sessionState?.sessionId,
				onTextDelta: pushTextDelta,
			});
			for (const message of result.diagnostics) diagnostic?.(message);
			reconcileFinalText(result.output);
			setUsage(result.usage);
			if (result.exitCode !== 0) throw new Error(result.errorMessage || `Muse exited with code ${result.exitCode}`);
			if (sessionState && result.sessionId) sessionState.sessionId = result.sessionId;
			await finish();
		} catch (error) {
			closeOpenBlock();
			output.stopReason = output.stopReason === "aborted" || options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			releaseSession();
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			releaseSession();
		}
	})();
	return stream;
}

function sandboxedFromEnvironment(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PI_MUSE_SANDBOXED?.trim() ?? "");
}

/** Register the provider and route interactive steering only to Muse-owned runs. */
export function registerMuseProvider(pi: ExtensionAPI): void {
	const plans = registerMusePlanDisplay(pi);
	pi.registerFlag("muse-sandboxed", {
		description: "Run Muse with its sandbox enabled and approval prompts disabled",
		type: "boolean",
		default: false,
	});
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" || ctx.model?.provider !== "muse-code") return;
		// Commands and explicit OMP queue markers retain OMP's parsing semantics.
		const trimmed = event.text.trimStart();
		if (trimmed.startsWith("/") || trimmed.startsWith("->") || trimmed.startsWith("=>")) return;
		if (!event.text.trim() && !(event.images?.length ?? 0)) return;
		const thinkingLevel = pi.getThinkingLevel();
		if (await steerActiveMuseRuns(event.text, event.images, thinkingLevel === "inherit" ? undefined : thinkingLevel)) {
			// Persist the echo without starting an OMP continuation while Muse owns the turn.
			pi.sendMessage({ customType: "muse-steer", content: event.text, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
			ctx.ui.notify("steered Muse", "info");
			return { handled: true };
		}
	});
	pi.registerMessageRenderer("muse-steer", (message) => {
		const content = message.content;
		const text = typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
		const lines = text.split("\n");
		return { render: () => [`↳ steered Muse: ${lines[0] ?? ""}`, ...lines.slice(1).map((line) => `  ${line}`)] };
	});
	pi.on("session_shutdown", () => shutdownHost());
	pi.registerProvider("muse-code", {
		baseUrl: "http://localhost",
		apiKey: "muse-code-local",
		api: MUSE_API,
		models: getMuseProviderModels(),
		streamSimple: (model, context, options) => streamMuse(model, context, options, {
			sandboxed: pi.getFlag("muse-sandboxed") === true || sandboxedFromEnvironment(),
			onDiagnostic: (message) => pi.logger.warn("omp-muse-bridge diagnostic", { message }),
			onTodoSnapshot: plans.forTurn(),
		}),
	});
}
