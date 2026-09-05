import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { errorMessage } from "./utils.ts";
import { museThinkingLevel, type MuseThinkingLevel, type MuseUsage } from "./contracts.ts";
import { resolveMuseModelId } from "./catalog.ts";

/** Muse Session Protocol client over newline-delimited JSON-RPC stdio. */

const HOST_CLIENT_INFO = { name: "omp_muse_bridge", title: "OMP omp-muse-bridge", version: "0.4.5" };

/** The host answers a late steer in a successor run: bound the wait for its `turn/started`. */
const SUCCESSOR_GRACE_MS = 5_000;

/** Grace after a user abort before the run settles itself as cancelled, regardless of host terminals. */
const ABORT_SETTLE_MS = 3_000;

/** Markdown activity prefix; inline formatting survives OMP's thinking display. */
const MUSE_TAG = "**[Muse]**";

export class HostUnavailableError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = "HostUnavailableError";
	}
}

/** A session opened without an observable event stream; no turn has been admitted. */
export class MuseSessionUnusableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MuseSessionUnusableError";
	}
}

export function uuidv7(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const ms = Date.now();
	bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
	bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
	bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
	bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
	bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
	bytes[5] = ms & 0xff;
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- wire-frame narrowing (RPC data is external input: check before read) ---

/** Raw ndjson frame: any JSON object on the wire. RPC data is external input: check before read. */
export type Frame = Record<string, unknown>;

function asRecord(value: unknown): Frame | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Frame : undefined;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `session/todoListChanged` items: `text`/`status`, replace the whole list (an empty array is a cleared list). */
export interface MuseTodoEntry {
	label: string;
	status: string;
}

/** Inbound ndjson envelope, narrowed before use. JSON-RPC ids may be strings or numbers. */
interface InboundMessage extends Frame {
	method: string;
	params: Frame;
}

/** One page of the durable view, normalized from the external `view/page` result. */
export interface DurablePage {
	readonly events: readonly InboundMessage[];
	readonly nextCursor: string | undefined;
}

/** Narrow a JSON-RPC notification before dispatching external data. */
function inboundMessage(message: Frame): InboundMessage | undefined {
	if (message.jsonrpc !== "2.0") return undefined;
	const method = text(message.method);
	if (!method) return undefined;
	const rawParams = message.params;
	if (rawParams !== undefined && !asRecord(rawParams)) return undefined;
	return { ...message, method, params: asRecord(rawParams) ?? {} };
}

function durablePage(result: Frame): DurablePage {
	if (!Array.isArray(result.events)) throw new Error("Muse durable page has no events array");
	const events: InboundMessage[] = [];
	for (const entry of result.events) {
		const frame = asRecord(entry);
		const method = frame ? text(frame.method) : "";
		const params = frame ? asRecord(frame.params) : undefined;
		if (method && params) events.push({ method, params });
	}
	return { events, nextCursor: text(result.nextCursor) || undefined };
}

interface RpcErrorInfo {
	message: string;
	kind?: string;
}

function rpcErrorInfo(error: unknown): RpcErrorInfo | undefined {
	const frame = asRecord(error);
	if (!frame) return undefined;
	const data = asRecord(frame.data);
	return {
		message: text(frame.message) || "unknown error",
		kind: data ? (typeof data.kind === "string" ? data.kind : undefined) : undefined,
	};
}

class MspRequestError extends Error {
	readonly kind: string | undefined;
	constructor(method: string, info: RpcErrorInfo) {
		super(`muse serve ${method} failed: ${info.message}${info.kind ? ` [${info.kind}]` : ""}`);
		this.name = "MspRequestError";
		this.kind = info.kind;
	}
}

// ---------------------------------------------------------------------------
// Host connection

interface PendingRequest {
	resolve: (value: Frame) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
	method: string;
}

class MuseHost {
	private nextRequestId = 1;
	private readonly pending = new Map<number | string, PendingRequest>();
	private readonly listeners = new Set<(method: string, params: Frame) => void>();
	private stdoutBuffer = "";
	private readonly stderrTail: string[] = [];
	private exited = false;
	readonly exitPromise: Promise<never>;
	private readonly exitResolvers: { reject: (error: Error) => void };

	private constructor(readonly child: ChildProcess) {
		const { promise, reject } = Promise.withResolvers<never>();
		this.exitPromise = promise;
		this.exitResolvers = { reject };
		this.exitPromise.catch(() => {});
		child.once("exit", (code, signal) => {
			this.exited = true;
			const detail = `muse serve exited (code ${code ?? signal})${this.stderrTail.length ? `; stderr: ${this.stderrTail.join(" ")}` : ""}`;
			for (const waiter of this.pending.values()) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error(detail));
			}
			this.pending.clear();
			reject(new Error(detail));
		});
		child.once("error", (error) => {
			this.exited = true;
			for (const waiter of this.pending.values()) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
			this.pending.clear();
			reject(error);
		});
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.consumeStdout(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			for (const line of String(chunk).split("\n")) {
				if (!line.trim()) continue;
				this.stderrTail.push(line.slice(0, 400));
				if (this.stderrTail.length > 30) this.stderrTail.shift();
			}
		});
	}

	static async connect(sandboxed: boolean): Promise<MuseHost> {
		const args = sandboxed ? ["serve", "--trust-workspace"] : ["serve", "--disable-sandbox", "--trust-workspace"];
		let child: ChildProcess;
		try {
			child = spawn(process.env.PI_MUSE_BINARY?.trim() || "muse", args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			throw new HostUnavailableError(`failed to spawn muse serve: ${errorMessage(error)}`, error);
		}
		const host = new MuseHost(child);
		try {
			await host.request("initialize", { clientInfo: HOST_CLIENT_INFO }, 15_000);
			host.notify("initialized", {});
		} catch (error) {
			host.dispose();
			throw new HostUnavailableError(`muse serve handshake failed: ${errorMessage(error)}`, error);
		}
		return host;
	}

	private consumeStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		for (;;) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.stdoutBuffer.slice(0, newline).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			let decoded: unknown;
			try {
				decoded = JSON.parse(line);
			} catch {
				continue;
			}
			const message = asRecord(decoded);
			if (!message) continue;
			if (message.jsonrpc !== "2.0") continue;
			const key = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
			if (message.method === undefined && key !== undefined) {
				const waiter = this.pending.get(key);
				if (waiter) {
					this.pending.delete(key);
					clearTimeout(waiter.timer);
					const errorInfo = asRecord(message.error);
					if (errorInfo) waiter.reject(new MspRequestError(waiter.method, rpcErrorInfo(errorInfo) ?? { message: "unknown error" }));
					else waiter.resolve(asRecord(message.result) ?? {});
				}
				continue;
			}
			const inbound = inboundMessage(message);
			if (!inbound) continue;
			for (const listener of [...this.listeners]) {
				try {
					listener(inbound.method, inbound.params);
				} catch {
					// listener faults never break the wire
				}
			}
		}
	}

	notify(method: string, params: Frame): void {
		if (this.exited || !this.child.stdin?.writable) return;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	request(method: string, params: Frame, timeoutMs?: number): Promise<Frame> {
		if (this.exited || !this.child.stdin?.writable) return Promise.reject(new HostUnavailableError("muse serve is not running"));
		const id = this.nextRequestId++;
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		const timer = timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`muse serve request ${method} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
		this.pending.set(id, {
			resolve: (value) => resolve(value),
			reject: (error) => reject(error),
			timer,
			method,
		});
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return promise;
	}

	onNotification(listener: (method: string, params: Frame) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get dead(): boolean {
		return this.exited;
	}

	dispose(): void {
		this.listeners.clear();
		try {
			this.child.kill("SIGTERM");
		} catch {
			// already gone
		}
	}
}

// ---------------------------------------------------------------------------
// Host management and active-run registry

let hostPromise: Promise<MuseHost> | null = null;

let activeHost: MuseHost | null = null;
/** Sandbox posture of the live host: the host is shared, so reuse requires the identical spawn. */
let activeHostSandboxed: boolean | undefined;
const sessionsOnHost = new Map<string, MuseHost>();

const sessionModelOnHost = new Map<string, string>();

export interface MuseRequester {
	request(method: string, params: Frame, timeoutMs?: number): Promise<Frame>;
}

interface TrackedItem {
	kind: string;
	turnId: string | undefined;
	lastDeltaField?: string;
	lastActivity?: string;
	/** Authoritative completed text for a completed agentMessage; kept per item. */
	finalText?: string;
	partialText?: string;
}

/** Callbacks and ownership for one observed Muse run. */
export interface TurnRunOptions {
	host: MuseRequester;
	sessionId: string;
	thinkingLevel?: MuseThinkingLevel;
	/** Agent text as it streams; `itemId` names the owning item when known. */
	onTextDelta?: (delta: string, itemId?: string) => void;
	onReasoningDelta?: (delta: string) => void;
	onActivityDelta?: (delta: string) => void;
	/** Canonical todo snapshot; replace the whole list, an empty array is a cleared list. */
	onTodoSnapshot?: (entries: MuseTodoEntry[]) => void;
	/**
	 * Authoritative completed text of one agent item, including durable catch-up recovery. The consumer reconciles
	 * that item's whole rendered text from it, so a late completion need not preserve corrupted streamed partials.
	 */
	onTextSnapshot?: (itemId: string, text: string) => void;
}

export class TurnRun {
	/** Items this run streams: kind + owning turnId. Only items owned by `turnId` (or with no owner) are admitted. */
	private readonly items = new Map<string, TrackedItem>();
	turnId: string | undefined;
	private usage: MuseUsage | undefined;
	private interrupted = false;
	private terminalResolved = false;
	private catchUpTask: Promise<void> | undefined;
	private gapRevision = 0;
	private readonly stopped = new AbortController();
	private readonly ownedTurnIds = new Set<string>();
	private readonly interruptedTurnIds = new Set<string>();
	private readonly pendingSteers = new Map<string, { answered: boolean }>();
	/** Set by view/gap; cleared by the first live event after it. Decides whether a failed catch-up may fail the turn. */
	private gapAwaitingLive = false;
	private readonly terminalResolvers: { resolve: (v: TurnTerminal) => void };
	readonly terminal: Promise<TurnTerminal>;
	readonly diagnostics: string[] = [];
	/** An accepted steer not yet consumed by a model call. */
	private awaitingSteeredAnswer = false;
	/** This turn's `completed` terminal, parked while a successor run is expected for an outstanding steer. */
	private heldTerminal: TurnTerminal | undefined;
	private successorTimer: ReturnType<typeof setTimeout> | undefined;
	private abortTimer: ReturnType<typeof setTimeout> | undefined;
	private reasoningEffort: string | undefined;
	private readonly host: MuseRequester;
	readonly sessionId: string;
	private readonly onTextDelta?: (delta: string, itemId?: string) => void;
	private readonly onReasoningDelta?: (delta: string) => void;
	private readonly onActivityDelta?: (delta: string) => void;
	private readonly onTodoSnapshot?: (entries: MuseTodoEntry[]) => void;
	private readonly onTextSnapshot?: (itemId: string, text: string) => void;

	constructor(options: TurnRunOptions) {
		this.host = options.host;
		this.sessionId = options.sessionId;
		this.onTextDelta = options.onTextDelta;
		this.onReasoningDelta = options.onReasoningDelta;
		this.onActivityDelta = options.onActivityDelta;
		this.onTodoSnapshot = options.onTodoSnapshot;
		this.onTextSnapshot = options.onTextSnapshot;
		this.reasoningEffort = museThinkingLevel(options.thinkingLevel);
		const { promise, resolve } = Promise.withResolvers<TurnTerminal>();
		this.terminal = promise;
		this.terminalResolvers = { resolve };
	}

	/** Live-path entry. Every live event is processed immediately; a view gap only starts a durable catch-up. */
	handleNotification(method: string, params: Frame): void {
		if (this.settledFlag) return;
		if (method !== "view/gap") this.gapAwaitingLive = false;
		this.process(method, params);
	}

	private settledFlag = false;

	/** Parsed tool arguments, or undefined when the model emitted non-JSON (the wire keeps `args` verbatim). */
	private static toolArgs(args: string): Frame | undefined {
		try {
			return asRecord(JSON.parse(args));
		} catch {
			return undefined;
		}
	}

	/** Select a compact target from the tool's arguments. */
	private static primaryArgument(record: Frame | undefined): string {
		if (!record) return "";
		for (const key of ["description", "path", "file_path", "filePath", "target_file", "query", "url", "pattern", "glob", "command", "objective", "prompt"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) {
				const flat = value.replace(/\s+/g, " ").trim();
				return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
			}
		}
		return "";
	}

	/** Decode a committed snapshot; malformed events must not clear the displayed plan. */
	private static todoEntries(record: Frame | undefined): MuseTodoEntry[] | undefined {
		if (!record || !Array.isArray(record.items)) return undefined;
		const parsed: MuseTodoEntry[] = [];
		for (const entry of record.items) {
			const todo = asRecord(entry);
			if (!todo || typeof todo.text !== "string" || typeof todo.status !== "string") return undefined;
			const label = todo.text.trim();
			if (!label) return undefined;
			parsed.push({
				label,
				status: text(todo.status) || "pending",
			});
		}
		return parsed;
	}

	/** Markdown fallback used when no consumer renders the snapshot itself. */
	private static renderTodoLines(entries: MuseTodoEntry[]): string {
		return entries.map(({ label, status }) => {
			const done = /done|complete/i.test(status);
			const glyph = /progress|active|doing/i.test(status) ? "▸" : done ? "✓" : /cancel|drop/i.test(status) ? "✗" : "□";
			return `- ${glyph} ${done ? `~~${label}~~` : label}`;
		}).join("\n");
	}

	/** Extract only failure reasons or bounded change-stat syntax, never arbitrary tool-output spans. */
	private static resultSummary(item: Frame): string {
		const failure = text(item.failureReason).replace(/\s+/g, " ").trim();
		if (failure) return failure.length > 160 ? `${failure.slice(0, 159)}…` : failure;
		const output = text(item.visibleOutput);
		const stats = /(?<![\w+-])(?:[+-]\d{1,9}[ \t]{1,8}[+-]\d{1,9}|\d{1,9}[ \t]{1,8}insertions?(?:\(\+\))?,[ \t]{0,8}\d{1,9}[ \t]{1,8}deletions?(?:\(-\))?|\d{1,9}[ \t]{1,8}lines?[ \t]{1,8}(?:added|removed|changed))(?![\w])/i.exec(output);
		return stats ? stats[0].replace(/\s+/g, " ").trim() : "";
	}

	/** Distinct hostnames referenced by a web result, without including page contents. */
	private static resultSites(item: Frame): string {
		const hosts: string[] = [];
		// The class stops where prose and Markdown put delimiters after a URL: only the host is used, so truncating
		// a path early is harmless.
		for (const match of text(item.visibleOutput).matchAll(/https?:\/\/[^\s"'`<>()[\]{}*|\\]+/g)) {
			let host = "";
			try {
				host = new URL(match[0].replace(/[.,;:!?]+$/, "")).hostname.replace(/^www\./, "").toLowerCase();
			} catch {
				continue;
			}
			// Backstop: `new URL` accepts hosts no name server would; report only label-shaped ones.
			if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host)) continue;
			if (!hosts.includes(host)) hosts.push(host);
			if (hosts.length === 5) break;
		}
		return hosts.join(", ");
	}

	private emitItemProgress(method: string, item: Frame, tracked: TrackedItem): void {
		const kind = tracked.kind;
		if (kind === "userMessage" || kind === "agentMessage") return;
		const rawStatus = text(item.status);
		const status = rawStatus === "inProgress" ? "started" : rawStatus || method.slice("item/".length);
		const terminal = status !== "started";
		// `fallbackText` is model-authored prose shown while the tool runs; `visibleOutput` is the raw tool payload
		// and is never quoted.
		const rawFallback = text(item.fallbackText).replace(/\s+/g, " ").trim();
		const fallback = rawFallback.length > 200 ? `${rawFallback.slice(0, 199)}…` : rawFallback;
		let message: string;
		if (kind === "toolCall") {
			const tool = text(item.tool) || "tool";
			const args = TurnRun.toolArgs(text(item.args));
			const target = TurnRun.primaryArgument(args);
			// A todo update is a plan, not tool noise: the call itself is always hidden. The authoritative list
			// arrives as `session/todoListChanged`, so neither its start nor its args are surfaced here.
			if (/todo/i.test(tool)) {
				return;
			} else if (!terminal) {
				message = /^web_search$/i.test(tool)
					? `${MUSE_TAG} 🔎 searched ${target ? `\`${target}\`` : "(query unavailable)"}`
					: /^web_fetch$/i.test(tool)
						? `${MUSE_TAG} 🌐 fetched ${target ? `\`${target}\`` : "(url unavailable)"}`
						: `${MUSE_TAG} → called \`${tool}\`${target ? ` on \`${target}\`` : ""}`;
			} else {
				const sites = /^web_(search|fetch)$/i.test(tool) ? TurnRun.resultSites(item) : "";
				const detail = sites ? `sources: ${sites}` : TurnRun.resultSummary(item) || fallback;
				const glyph = status === "completed" ? "✓" : status === "failed" ? "✗" : "•";
				const outcome = status === "completed" ? "finished" : status;
				message = `${MUSE_TAG} ${glyph} \`${tool}\` ${outcome}${target ? ` on \`${target}\`` : ""}${detail ? ` — ${detail}` : ""}`;
			}
		} else {
			let label: string;
			if (kind === "reasoning") label = `${MUSE_TAG} 💭 reasoning`;
			else if (kind === "userShell") {
				const command = text(item.commandText).replace(/\s+/g, " ").trim();
				label = `${MUSE_TAG} ❯ shell${command ? ` \`${command.length > 120 ? `${command.slice(0, 119)}…` : command}\`` : ""}`;
			} else if (kind === "subagent") label = `${MUSE_TAG} 🤖 subagent${text(item.role) ? ` \`${text(item.role)}\`` : ""}`;
			else if (kind === "workflow") label = `${MUSE_TAG} ⚙ workflow${text(item.scriptId) ? ` \`${text(item.scriptId)}\`` : ""}`;
			else if (kind === "compaction") label = `${MUSE_TAG} 🗜 compaction`;
			else if (kind === "reminderChild") label = `${MUSE_TAG} ⏰ reminder`;
			else label = `${MUSE_TAG} ${kind}`;
			const suffix = (terminal ? TurnRun.resultSummary(item) : "") || fallback;
			message = `${label} — ${status}${suffix ? `: ${suffix}` : ""}`;
		}
		if (message === tracked.lastActivity) return;
		tracked.lastActivity = message;
		const delta = `\n\n${message}\n`;
		if (kind === "reasoning") this.onReasoningDelta?.(delta);
		else this.onActivityDelta?.(delta);
	}

	private process(method: string, params: Frame): void {
		if (this.settledFlag) return;
		if (method === "view/gap") {
			const after = text(params.after);
			const next = text(params.next);
			this.diagnostics.push(`Muse view stream dropped events between cursor ${after || "?"} and ${next || "?"}; streamed text may be incomplete, final text is authoritative`);
			this.gapAwaitingLive = true;
			this.gapRevision++;
			this.startCatchUp();
			return;
		}
		if (method === "turn/started") {
			// A late steer may continue under a successor turn ID in the same response stream.
			const startedTurnId = text(params.turnId);
			if (this.heldTerminal && startedTurnId && startedTurnId !== this.turnId) {
				if (this.turnId) this.ownedTurnIds.add(this.turnId);
				clearTimeout(this.successorTimer);
				this.successorTimer = undefined;
				this.heldTerminal = undefined;
				this.turnId = startedTurnId;
				this.ownedTurnIds.add(startedTurnId);
				if (this.interrupted) this.interruptCurrentTurn();
			}
			if (!startedTurnId || startedTurnId !== this.turnId) return;
			this.onActivityDelta?.(`\n\n${MUSE_TAG} turn started\n`);
			return;
		}
		if (method === "item/started" || method === "item/updated" || method === "item/completed") {
			const item = asRecord(params.item);
			const itemId = item ? text(item.itemId) : "";
			const kind = item ? text(item.kind) : "";
			if (!item || !itemId || !kind) return;
			// Only items belonging to this run may acknowledge its steering.
			const existing = this.items.get(itemId);
			const ownerTurnId = typeof item.turnId === "string" ? item.turnId : existing?.turnId;
			if (this.turnId && ownerTurnId !== undefined && ownerTurnId !== this.turnId && !this.ownedTurnIds.has(ownerTurnId)) return;
			if (method === "item/completed" && kind === "userMessage" && item.steered === true) {
				this.awaitingSteeredAnswer = false;
				for (const pending of this.pendingSteers.values()) pending.answered = true;
			}
			const tracked = existing?.kind === kind ? existing : { kind, turnId: ownerTurnId };
			tracked.kind = kind;
			tracked.turnId = ownerTurnId;
			this.items.set(itemId, tracked);
			if (method === "item/completed" && kind === "agentMessage" && typeof item.text === "string") {
				tracked.finalText = item.text;
				this.onTextSnapshot?.(itemId, item.text);
			}
			this.emitItemProgress(method, item, tracked);
			return;
		}
		if (method === "item/delta") {
			const itemId = text(params.itemId);
			const tracked = this.items.get(itemId);
			if (!tracked) return; // unknown or foreign item: dropped
			const field = typeof params.field === "string" && params.field ? params.field : "text";
			const delta = text(params.delta);
			if (!delta) return;
			if (tracked.kind === "agentMessage" && field === "text") {
				tracked.partialText = (tracked.partialText ?? "") + delta;
				this.onTextDelta?.(delta, itemId);
			} else if (tracked.kind === "reasoning" && /^summary\.\d+$/.test(field)) {
				if (tracked.lastDeltaField && tracked.lastDeltaField !== field) this.onReasoningDelta?.("\n\n");
				tracked.lastDeltaField = field;
				this.onReasoningDelta?.(delta);
			}
			// Tool/shell `output` deltas are deliberately not surfaced: the lifecycle labels from emitItemProgress
			// carry the signal, and raw tool output (e.g. a full directory listing) floods the transcript.
			return;
		}
		if (method === "session/todoListChanged") {
			// Canonical snapshot replaces the whole list; an empty `items` array is a cleared list, not a no-op.
			const entries = TurnRun.todoEntries(params);
			if (!entries) {
				this.diagnostics.push("Muse sent a malformed todo snapshot; retaining the committed plan");
				return;
			}
			if (this.onTodoSnapshot) this.onTodoSnapshot(entries);
			else if (entries.length) this.onActivityDelta?.(`\n\n${MUSE_TAG} plan\n${TurnRun.renderTodoLines(entries)}\n`);
			return;
		}
		if (method === "session/contextUsage") {
			if (typeof params.usedTokens !== "number" || !Number.isFinite(params.usedTokens) || params.usedTokens < 0) return;
			this.usage ??= { ...EMPTY_USAGE };
			this.usage.contextTokens = params.usedTokens;
			return;
		}
		if (method === "session/tokenUsage") {
			const owner = text(params.turnId);
			if (owner && owner !== this.turnId && !this.ownedTurnIds.has(owner)) return;
			const frame = asRecord(params.usage);
			const prompt = typeof params.promptTokens === "number" && Number.isFinite(params.promptTokens) ? params.promptTokens : undefined;
			const total = typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens) ? params.totalTokens : undefined;
			if (!frame && prompt === undefined && total === undefined) return;
			this.usage ??= { ...EMPTY_USAGE };
			const cacheReadTokens = numeric(frame?.cacheReadTokens ?? frame?.cachedTokens);
			const cacheWriteTokens = numeric(frame?.cacheWriteTokens);
			const rawInput = numeric(frame?.inputTokens);
			const promptTokens = prompt ?? rawInput + cacheReadTokens + cacheWriteTokens;
			const output = numeric(frame?.outputTokens);
			this.usage.input += prompt === undefined ? rawInput : Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
			this.usage.output += output;
			this.usage.cacheRead += cacheReadTokens;
			this.usage.cacheWrite += cacheWriteTokens;
			this.usage.totalTokens += total ?? promptTokens + output;
			this.usage.turns += 1;
			return;
		}
		if (method === "turn/completed") {
			if (this.turnId && text(params.turnId) !== this.turnId) return;
			const error = asRecord(params.error);
			const value: TurnTerminal = {
				terminal: text(params.terminal) || "failed",
				errorText: error ? rpcErrorInfo(error)?.message : undefined,
				interrupted: this.interrupted,
				localAbort: false,
			};
			if (value.terminal === "completed" && this.hasUnansweredSteer && !this.interrupted) {
				// Preserve the response stream while a pending or accepted steer awaits its successor.
				this.heldTerminal = value;
				this.successorTimer = setTimeout(() => {
					this.successorTimer = undefined;
					const held = this.heldTerminal;
					if (!held) return;
					this.heldTerminal = undefined;
					this.awaitingSteeredAnswer = false;
					this.diagnostics.push("Muse accepted a steer but started no successor run; the steered input was not answered in this turn");
					this.resolveTerminal(held);
				}, SUCCESSOR_GRACE_MS);
				return;
			}
			this.resolveTerminal(value);
		}
	}

	private resolveTerminal(value: TurnTerminal): void {
		if (this.terminalResolved) return;
		this.terminalResolved = true;
		this.awaitingSteeredAnswer = false;
		this.terminalResolvers.resolve(value);
	}

	/** Retain a promise for recovery so terminal publication can await every recovered completion. */
	private startCatchUp(): void {
		if (this.catchUpTask || this.settledFlag) return;
		const revision = this.gapRevision;
		this.catchUpTask = this.durableCatchUp().finally(() => {
			this.catchUpTask = undefined;
			if (revision !== this.gapRevision && !this.settledFlag) this.startCatchUp();
		});
	}

	/** Durable cursors are independent of live cursors; recover completed items from the beginning. */
	private async durableCatchUp(): Promise<void> {
		const deadline = Date.now() + 15_000;
		let failure: unknown;
		for (let attempt = 1; attempt <= 3 && !this.settledFlag; attempt++) {
			try {
				let cursor = "";
				for (let page = 0; page < 50; page++) {
					const timeout = deadline - Date.now();
					if (timeout <= 0) throw new Error("Muse durable recovery exceeded its deadline");
					const result = durablePage(await this.host.request("view/page", {
						sessionId: this.sessionId, ...(cursor ? { cursor } : {}), direction: "forward", limit: 1000,
					}, timeout));
					if (this.settledFlag) return;
					for (const event of result.events) {
						if (event.method === "item/completed" && asRecord(event.params.item)?.kind === "agentMessage") {
							this.process(event.method, event.params);
						} else if (event.method === "turn/completed" && !this.terminalResolved) {
							this.process(event.method, event.params);
						}
					}
					if (!result.nextCursor || result.nextCursor === cursor) return;
					cursor = result.nextCursor;
				}
				throw new Error("Muse durable recovery exceeded its page limit");
			} catch (error) {
				failure = error;
				if (this.settledFlag) return;
				if (attempt === 3 || Date.now() + 2_000 >= deadline) break;
				this.diagnostics.push(`Muse durable recovery attempt ${attempt} failed; retrying`);
				try {
					await delay(2_000, undefined, { signal: this.stopped.signal });
				} catch {
					return;
				}
			}
		}
		if (this.settledFlag) return;
		const detail = `Muse durable recovery failed: ${errorMessage(failure)}`;
		if (this.gapAwaitingLive && !this.terminalResolved) {
			this.resolveTerminal({ terminal: "failed", errorText: detail, interrupted: false, localAbort: false });
		} else {
			this.diagnostics.push(`${detail}; continuing with live output`);
		}
	}

	async drainCatchUp(): Promise<void> {
		while (this.catchUpTask && !this.settledFlag) await this.catchUpTask;
	}

	/** Streamed agent text with each completed item's authoritative replacement applied. */
	get finalText(): string {
		let result = "";
		for (const tracked of this.items.values()) {
			if (tracked.kind === "agentMessage") result += tracked.finalText ?? tracked.partialText ?? "";
		}
		return result;
	}

	get tokenUsage(): MuseUsage | undefined {
		return this.usage;
	}

	/** Steering is valid only while this run owns a live, uninterrupted turn. */
	private get steerable(): boolean {
		return !this.settledFlag && !this.terminalResolved && !this.interrupted && !this.heldTerminal && this.turnId !== undefined;
	}

	private get hasUnansweredSteer(): boolean {
		if (this.awaitingSteeredAnswer) return true;
		for (const pending of this.pendingSteers.values()) if (!pending.answered) return true;
		return false;
	}

	async steer(input: Frame[], expectedTurnId?: string, thinkingLevel?: MuseThinkingLevel): Promise<boolean> {
		if (!this.steerable) return false;
		const turnId = expectedTurnId ?? this.turnId;
		if (!turnId) return false;
		const reasoningEffort = museThinkingLevel(thinkingLevel) ?? this.reasoningEffort;
		const commandId = uuidv7();
		const pending = { answered: false };
		this.pendingSteers.set(commandId, pending);
		try {
			await this.host.request("turn/steer", {
				commandId, sessionId: this.sessionId, expectedTurnId: turnId, input,
				...(reasoningEffort ? { reasoningEffort } : {}),
			}, 10_000);
			if (!pending.answered) this.awaitingSteeredAnswer = true;
			this.reasoningEffort = reasoningEffort;
			return true;
		} catch (error) {
			this.diagnostics.push(`Muse steer failed (${errorMessage(error)}); input falls through to OMP`);
			return false;
		} finally {
			this.pendingSteers.delete(commandId);
			const held = this.heldTerminal;
			if (held && !this.hasUnansweredSteer && !this.terminalResolved) {
				this.heldTerminal = undefined;
				clearTimeout(this.successorTimer);
				this.successorTimer = undefined;
				this.resolveTerminal(held);
			}
		}
	}

	private interruptCurrentTurn(): void {
		const turnId = this.turnId;
		if (!turnId || this.interruptedTurnIds.has(turnId) || this.settledFlag) return;
		this.interruptedTurnIds.add(turnId);
		void this.host.request("turn/interrupt", { commandId: uuidv7(), sessionId: this.sessionId, turnId }, 10_000)
			.catch((error: unknown) => this.diagnostics.push(`Muse interruption was not acknowledged: ${errorMessage(error)}`));
	}

	markInterrupted(): void {
		this.interrupted = true;
		this.interruptCurrentTurn();
		// Local settlement bounds UI waiting; it does not prove that the host stopped.
		clearTimeout(this.abortTimer);
		this.abortTimer = setTimeout(() => {
			this.abortTimer = undefined;
			if (this.settledFlag || this.terminalResolved) return;
			this.diagnostics.push("Muse did not report a terminal for the interrupted turn; settling it locally as cancelled");
			// localAbort: this run settled itself; it says nothing about what the backend ran.
			this.resolveTerminal({ terminal: "cancelled", errorText: undefined, interrupted: true, localAbort: true });
		}, ABORT_SETTLE_MS);
	}

	settle(): void {
		this.settledFlag = true;
		this.stopped.abort();
		this.pendingSteers.clear();
		this.awaitingSteeredAnswer = false;
		clearTimeout(this.successorTimer);
		this.successorTimer = undefined;
		clearTimeout(this.abortTimer);
		this.abortTimer = undefined;
	}
}

interface TurnTerminal {
	terminal: string;
	errorText?: string;
	interrupted: boolean;
	/** True when the run settled itself on the local abort timer, not from a host terminal. */
	localAbort: boolean;
}

const activeRuns = new Map<string, TurnRun>();

function hostListener(method: string, params: Frame): void {
	if (method === "userInput/requested") {
		const host = sessionsOnHost.get(text(params.sessionId));
		const userInputId = text(params.userInputId);
		const sessionId = text(params.sessionId);
		if (host && userInputId && sessionId) {
			host.request("userInput/cancel", { commandId: uuidv7(), sessionId, userInputId, reason: "omp-muse-bridge: headless run cannot answer prompts" }, 10_000).catch(() => {});
		}
		return;
	}
	activeRuns.get(text(params.sessionId))?.handleNotification(method, params);
}

export async function ensureHost(sandboxed: boolean): Promise<MuseHost> {
	if (activeHost && !activeHost.dead && activeHostSandboxed === sandboxed) return activeHost;
	if (activeHost && !activeHost.dead && activeHostSandboxed !== sandboxed) {
		if (activeRuns.size) throw new Error("Cannot change Muse sandbox posture while a host turn is active");
		shutdownHost();
	}
	if (!hostPromise) {
		hostPromise = MuseHost.connect(sandboxed)
			.then((host) => {
				activeHost = host;
				activeHostSandboxed = sandboxed;
				host.onNotification(hostListener);
				host.exitPromise.catch(() => {
					if (activeHost === host) {
						activeHost = null;
						activeHostSandboxed = undefined;
						hostPromise = null;
						for (const [key, value] of [...sessionsOnHost]) if (value === host) {
							sessionsOnHost.delete(key);
							sessionModelOnHost.delete(key);
						}
					}
				});
				return host;
			})
			.catch((error: unknown) => {
				hostPromise = null;
				throw error;
			});
	}
	return hostPromise;
}

export function shutdownHost(): void {
	const host = activeHost;
	activeHost = null;
	activeHostSandboxed = undefined;
	hostPromise = null;
	sessionsOnHost.clear();
	sessionModelOnHost.clear();
	activeRuns.clear();
	host?.dispose();
}

/** Route user input only to a live Muse run in this process. */
export async function steerActiveMuseRuns(
	textInput: string,
	images?: Array<{ data?: string; mimeType?: string }>,
	thinkingLevel?: MuseThinkingLevel,
): Promise<boolean> {
	const input: Frame[] = [];
	if (textInput) input.push({ type: "text", text: textInput });
	for (const image of images ?? []) {
		if (typeof image.data === "string" && typeof image.mimeType === "string") {
			input.push({ type: "image", base64Data: image.data, mediaType: image.mimeType });
		}
	}
	if (!input.length) return false;
	for (const run of [...activeRuns.values()]) {
		if (await run.steer(input, undefined, thinkingLevel)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Host-backed turn runner

export interface MuseTurnArgs {
	sessionId: string;
	/** True when the session already exists (started or exec'd earlier) and must be resumed on this host. */
	resumeExisting: boolean;
	prompt: string;
	/** Build the complete seed only when a new backend session needs it. */
	initialPrompt?: () => string;
	modelId: string;
	workspace: string;
	thinkingLevel?: MuseThinkingLevel;
	sandboxed: boolean;
	signal?: AbortSignal;
	/** Agent text as it streams; `itemId` names the owning item when known. */
	onTextDelta?: (delta: string, itemId?: string) => void;
	onReasoningDelta?: (delta: string) => void;
	onActivityDelta?: (delta: string) => void;
	/** Canonical todo snapshot; the caller renders it (OMP has no todo-write API for extensions). */
	onTodoSnapshot?: (entries: MuseTodoEntry[]) => void;
	/**
	 * Authoritative completed text of one agent item, including durable catch-up. The caller reconciles that
	 * item's rendered text from it, so a late authoritative completion need not preserve corrupted streamed
	 * partials.
	 */
	onTextSnapshot?: (itemId: string, text: string) => void;
}

export interface MuseTurnOutcome {
	/** Full agent transcript: every completed agent message of this turn, in arrival order. */
	output: string;
	usage: MuseUsage;
	diagnostics: string[];
	/** Set when the turn failed after admission. */
	errorMessage?: string;
	/** Set when the caller cancelled the turn (local decision; never implies the backend stopped). */
	aborted?: boolean;
	/** Set with `aborted` when a host terminal confirmed the cancellation (never when the run settled locally). */
	backendInterrupted?: boolean;
}

const EMPTY_USAGE: MuseUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };

function abortedBeforeAdmission(diagnostics: string[] = []): MuseTurnOutcome {
	return { output: "", usage: { ...EMPTY_USAGE }, diagnostics, aborted: true, errorMessage: "Muse turn was interrupted before admission" };
}

/** Cancel local waiting without abandoning the underlying request's rejection handler. */
function abortable<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return request;
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(new Error("Muse request was interrupted"));
		};
		signal.addEventListener("abort", abort, { once: true });
		request.then(
			(value) => { signal.removeEventListener("abort", abort); resolve(value); },
			(error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
		);
		if (signal.aborted) abort();
	});
}

/** Run a host turn; fallback is allowed only when no turn/start request has been sent. */
export async function runMuseTurn(args: MuseTurnArgs): Promise<MuseTurnOutcome> {
	if (args.signal?.aborted) return abortedBeforeAdmission();
	const museModelId = resolveMuseModelId(args.modelId);
	let host: MuseHost;
	try {
		host = await abortable(ensureHost(args.sandboxed), args.signal);
	} catch (error) {
		if (args.signal?.aborted) return abortedBeforeAdmission();
		throw error;
	}
	if (activeRuns.has(args.sessionId)) throw new Error("This Muse session already has an active turn");
	const run = new TurnRun({
		host, sessionId: args.sessionId, thinkingLevel: args.thinkingLevel,
		onTextDelta: args.onTextDelta, onTextSnapshot: args.onTextSnapshot,
		onReasoningDelta: args.onReasoningDelta, onActivityDelta: args.onActivityDelta,
		onTodoSnapshot: args.onTodoSnapshot,
	});
	const turnCommand = uuidv7();
	run.turnId = turnCommand;
	activeRuns.set(args.sessionId, run);
	const abortHandler = () => run.markInterrupted();
	const request = (method: string, params: Frame) => abortable(host.request(method, params, 20_000), args.signal);
	const waitTerminal = () => Promise.race([run.terminal, host.exitPromise]);
	let admitted = false;
	let turnStartSent = false;
	try {
		let createdSession = false;
		if (sessionsOnHost.get(args.sessionId) !== host) {
			const startParams: Frame = {
				commandId: uuidv7(), sessionId: args.sessionId, workspaceRoot: args.workspace,
				approvalMode: "allowAll", modelId: museModelId,
			};
			const resumeParams: Frame = { commandId: uuidv7(), sessionId: args.sessionId };
			let openedWithStart = !args.resumeExisting;
			let opened: Frame;
			try {
				opened = args.resumeExisting
					? await request("session/resume", resumeParams)
					: await request("session/start", startParams);
			} catch (error) {
				if (args.signal?.aborted) throw error;
				const kind = error instanceof MspRequestError ? error.kind : undefined;
				// Muse 1.0.3 reports an existing ID through commandRejected rather than sessionInUse.
				const exists = kind === "sessionInUse" ||
					(kind === "commandRejected" && /already exists or is reserved/i.test(errorMessage(error)));
				if (!args.resumeExisting && exists) {
					opened = await request("session/resume", { ...resumeParams, commandId: uuidv7() });
					openedWithStart = false;
				} else if (args.resumeExisting && kind === "sessionNotFound") {
					opened = await request("session/start", { ...startParams, commandId: uuidv7() });
					openedWithStart = true;
				} else {
					throw new HostUnavailableError(`Muse host could not open session ${args.sessionId}: ${errorMessage(error)}`, error);
				}
			}
			if (!text(opened.viewCursor)) {
				throw new MuseSessionUnusableError(`Muse session ${args.sessionId} has an empty viewCursor and cannot be observed`);
			}
			sessionsOnHost.set(args.sessionId, host);
			createdSession = openedWithStart;
			if (createdSession) sessionModelOnHost.set(args.sessionId, museModelId);
		}
		if (sessionModelOnHost.get(args.sessionId) !== museModelId) {
			await request("session/setModel", {
				commandId: uuidv7(), sessionId: args.sessionId, model: { modelId: museModelId },
			});
			sessionModelOnHost.set(args.sessionId, museModelId);
		}
		if (args.signal?.aborted) return abortedBeforeAdmission(run.diagnostics);
		args.signal?.addEventListener("abort", abortHandler, { once: true });
		const firstInput = createdSession ? args.initialPrompt?.() ?? args.prompt : args.prompt;
		turnStartSent = true;
		const ack = await request("turn/start", {
			commandId: turnCommand, sessionId: args.sessionId,
			input: [{ type: "text", text: firstInput }],
			...(args.thinkingLevel ? { reasoningEffort: museThinkingLevel(args.thinkingLevel) } : {}),
		});
		// The command ID already owns early notifications; do not rewind a successor adopted before the ack.
		if (run.turnId === turnCommand) run.turnId = text(ack.turnId) || turnCommand;
		admitted = true;
		if (args.signal?.aborted) abortHandler();
		const terminal = await waitTerminal();
		if (!args.signal?.aborted && terminal.terminal !== "cancelled") await abortable(run.drainCatchUp(), args.signal);
		const usage = { ...(run.tokenUsage ?? EMPTY_USAGE) };
		if (!usage.turns) usage.turns = 1;
		const backendInterrupted = !terminal.localAbort && terminal.terminal === "cancelled";
		if (args.signal?.aborted || terminal.interrupted || terminal.terminal === "cancelled") {
			return {
				output: run.finalText, usage, diagnostics: run.diagnostics, aborted: true, backendInterrupted,
				errorMessage: terminal.localAbort
					? "Muse cancellation requested; backend termination was not confirmed"
					: "Muse turn was interrupted",
			};
		}
		return {
			output: run.finalText, usage, diagnostics: run.diagnostics,
			...(terminal.terminal !== "completed" ? { errorMessage: terminal.errorText ?? `Muse turn ended: ${terminal.terminal}` } : {}),
		};
	} catch (error) {
		if (!turnStartSent) {
			if (args.signal?.aborted) return abortedBeforeAdmission(run.diagnostics);
			if (error instanceof HostUnavailableError || error instanceof MuseSessionUnusableError) throw error;
			throw new HostUnavailableError(`Muse host failed before admission: ${errorMessage(error)}`, error);
		}
		let cancellation: TurnTerminal | undefined;
		if (!admitted || args.signal?.aborted) {
			run.markInterrupted();
			try {
				cancellation = await waitTerminal();
			} catch {
				// Host death is already represented by the original request failure.
			}
		}
		return {
			output: run.finalText, usage: { ...(run.tokenUsage ?? EMPTY_USAGE) }, diagnostics: run.diagnostics,
			errorMessage: args.signal?.aborted && (!cancellation || cancellation.localAbort)
				? "Muse cancellation requested; backend termination was not confirmed"
				: errorMessage(error),
			aborted: args.signal?.aborted === true,
			backendInterrupted: cancellation?.terminal === "cancelled" && !cancellation.localAbort,
		};
	} finally {
		run.settle();
		args.signal?.removeEventListener("abort", abortHandler);
		if (activeRuns.get(args.sessionId) === run) activeRuns.delete(args.sessionId);
	}
}
