import { spawn, type ChildProcess } from "node:child_process";
import { errorMessage } from "./utils.ts";
import { museThinkingLevel, type MuseThinkingLevel, type MuseUsage } from "./contracts.ts";
import { resolveMuseModelId } from "./catalog.ts";

// Muse Session Protocol (MSP) client: ndjson JSON-RPC 2.0 over `muse serve` stdio.
// Wire notes: ../WIRE.md. Tier 1 = persistent host under streamSimple; tier 2 = active-run steer registry.

const HOST_CLIENT_INFO = { name: "omp_muse_bridge", title: "OMP omp-muse-bridge", version: "0.4.0" };

/** Observed muse 1.0.2: a steer that lands after the turn's last model call is answered by a successor run whose
 * `turn/started` follows the steered turn's `turn/completed` by ~50 ms (msdv_B1/B4b). Bound the wait for it. */
const SUCCESSOR_GRACE_MS = 5_000;

/** Grace after a user abort before the run settles itself as cancelled, regardless of host terminals. */
const ABORT_SETTLE_MS = 3_000;

export class HostUnavailableError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = "HostUnavailableError";
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

type Frame = Record<string, unknown>;

function asRecord(value: unknown): Frame | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Frame : undefined;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
	private readonly pending = new Map<number, PendingRequest>();
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
			child = spawn("muse", args, { stdio: ["pipe", "pipe", "pipe"] });
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
			let message: Frame;
			try {
				message = JSON.parse(line) as Frame;
			} catch {
				continue;
			}
			const id = typeof message.id === "number" ? message.id : undefined;
			if (id !== undefined) {
				const waiter = this.pending.get(id);
				if (waiter) {
					this.pending.delete(id);
					clearTimeout(waiter.timer);
					const errorInfo = asRecord(message.error);
					if (errorInfo) waiter.reject(new MspRequestError(waiter.method, rpcErrorInfo(errorInfo) ?? { message: "unknown error" }));
					else waiter.resolve(asRecord(message.result) ?? {});
					continue;
				}
			}
			const method = text(message.method);
			if (!method) continue;
			const params = asRecord(message.params) ?? {};
			for (const listener of [...this.listeners]) {
				try {
					listener(method, params);
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
// Host management + tier-2 run registry

let hostPromise: Promise<MuseHost> | null = null;
let activeHost: MuseHost | null = null;
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
}

export class TurnRun {
	/** Items this run streams: kind + owning turnId. Only items owned by `turnId` (or with no owner) are admitted. */
	private readonly items = new Map<string, TrackedItem>();
	turnId: string | undefined;
	private lastAgentText = "";
	private settled = false;
	private usage: Frame | undefined;
	private interrupted = false;
	private terminalResolved = false;
	private catchingUp = false;
	/** Set by view/gap; cleared by the first live event after it. Decides whether a failed catch-up may fail the turn. */
	private gapAwaitingLive = false;
	private readonly terminalResolvers: { resolve: (v: TurnTerminal) => void };
	readonly terminal: Promise<TurnTerminal>;
	readonly diagnostics: string[] = [];
	/** turn/steer acks not yet matched by a `userMessage{steered:true}` item — the host still owes an answer. */
	private outstandingSteers = 0;
	/** This turn's `completed` terminal, parked while a successor run is expected for an outstanding steer. */
	private heldTerminal: TurnTerminal | undefined;
	private successorTimer: ReturnType<typeof setTimeout> | undefined;
	private abortTimer: ReturnType<typeof setTimeout> | undefined;
	private reasoningEffort: string | undefined;

	constructor(
		private readonly host: MuseRequester,
		readonly sessionId: string,
		private readonly onTextDelta?: (delta: string) => void,
		private readonly onReasoningDelta?: (delta: string) => void,
		private readonly onActivityDelta?: (delta: string) => void,
		thinkingLevel?: MuseThinkingLevel,
	) {
		this.reasoningEffort = museThinkingLevel(thinkingLevel);
		const { promise, resolve } = Promise.withResolvers<TurnTerminal>();
		this.terminal = promise;
		this.terminalResolvers = { resolve };
	}

	/** Live-path entry. Every live event is processed immediately; a view gap only starts a durable catch-up. */
	handleNotification(method: string, params: Frame): void {
		if (this.settled) return;
		if (method !== "view/gap") this.gapAwaitingLive = false;
		this.process(method, params);
	}

	/** Parsed tool arguments, or undefined when the model emitted non-JSON (the wire keeps `args` verbatim). */
	private static toolArgs(args: string): Frame | undefined {
		try {
			return asRecord(JSON.parse(args));
		} catch {
			return undefined;
		}
	}

	/** Most informative argument for a tool call, by the field names Muse's tools actually use. */
	private static primaryArgument(record: Frame | undefined): string {
		if (!record) return "";
		for (const key of ["path", "file_path", "filePath", "target_file", "query", "url", "pattern", "glob", "command", "objective", "prompt"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) {
				const flat = value.replace(/\s+/g, " ").trim();
				return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
			}
		}
		if (Array.isArray(record.todos)) return `${record.todos.length} item${record.todos.length === 1 ? "" : "s"}`;
		return "";
	}

	/**
	 * Muse's todo list rendered as readable lines, so a plan update is visible instead of an opaque tool call.
	 * Muse spells the collection `todos` or `items`, and the entry label `text` (also seen: content/title/task).
	 */
	private static todoLines(record: Frame | undefined): string {
		if (!record) return "";
		const entries = Array.isArray(record.todos) ? record.todos : Array.isArray(record.items) ? record.items : undefined;
		if (!entries) return "";
		return entries.slice(0, 20).map((entry) => {
			const todo = asRecord(entry);
			if (!todo) return "";
			const label = text(todo.text) || text(todo.content) || text(todo.title) || text(todo.task);
			if (!label) return "";
			const state = text(todo.status) || text(todo.state) || "pending";
			const flat = label.replace(/\s+/g, " ").trim();
			return `  • ${state}: ${flat.length > 100 ? `${flat.slice(0, 99)}…` : flat}`;
		}).filter(Boolean).join("\n");
	}

	/**
	 * Terminal-state detail. Deliberately NOT the tool's raw `visibleOutput` — that is file contents, listings and
	 * command output the transcript is meant to stay free of. Only a failure reason, or a change summary the tool
	 * itself stated in a recognizable form (e.g. `+12 -5`, `3 insertions`), is surfaced.
	 */
	private static resultSummary(item: Frame): string {
		const failure = text(item.failureReason).replace(/\s+/g, " ").trim();
		if (failure) return failure.length > 160 ? `${failure.slice(0, 159)}…` : failure;
		const output = text(item.visibleOutput);
		const stats = /([+-]\d+\s+[+-]\d+)|(\d+\s+insertions?[^,]*,\s*\d+\s+deletions?)|(\d+\s+lines?\s+(?:added|removed|changed))/i.exec(output);
		return stats ? stats[0].replace(/\s+/g, " ").trim() : "";
	}

	/** Hosts a web tool actually reached, so a search reports its sources without pasting page text. */
	private static resultSites(item: Frame): string {
		const hosts: string[] = [];
		for (const match of text(item.visibleOutput).matchAll(/https?:\/\/\S+/g)) {
			let host = "";
			try {
				// Trim characters that commonly trail a URL in prose/JSON before parsing.
				host = new URL(match[0].replace(/[)\]}>"',.;:]+$/, "").replace(/\\[a-z].*$/i, "")).hostname;
			} catch {
				continue;
			}
			host = host.replace(/^www\./, "");
			if (host && !hosts.includes(host)) hosts.push(host);
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
		const rawFallback = text(item.fallbackText).replace(/\s+/g, " ").trim();
		const fallback = rawFallback.length > 200 ? `${rawFallback.slice(0, 199)}…` : rawFallback;
		let message: string;
		let body = "";
		if (kind === "toolCall") {
			const tool = text(item.tool) || "tool";
			const args = TurnRun.toolArgs(text(item.args));
			const target = TurnRun.primaryArgument(args);
			// A todo update is a plan, not tool noise: show the list and hide the call itself entirely.
			if (/todo/i.test(tool)) {
				if (terminal) return;
				const lines = TurnRun.todoLines(args);
				if (!lines) return;
				message = `[Muse] plan:\n${lines}`;
			} else if (!terminal) {
				message = /^web_search$/i.test(tool)
					? `[Muse] searched: ${target || "(query unavailable)"}`
					: /^web_fetch$/i.test(tool)
						? `[Muse] fetched ${target || "(url unavailable)"}`
						: `[Muse] called ${tool}${target ? ` on ${target}` : ""}`;
			} else {
				const sites = /^web_(search|fetch)$/i.test(tool) ? TurnRun.resultSites(item) : "";
				const detail = sites ? `sources: ${sites}` : TurnRun.resultSummary(item) || fallback;
				const outcome = status === "completed" ? "finished" : status;
				message = `[Muse] ${tool} ${outcome}${target ? ` on ${target}` : ""}${detail ? ` — ${detail}` : ""}`;
			}
		} else {
			let label: string;
			if (kind === "reasoning") label = "[Muse] reasoning";
			else if (kind === "userShell") {
				const command = text(item.commandText).replace(/\s+/g, " ").trim();
				label = `[Muse] shell${command ? ` · ${command.length > 120 ? `${command.slice(0, 119)}…` : command}` : ""}`;
			} else if (kind === "subagent") label = `[Muse] subagent${text(item.role) ? ` · ${text(item.role)}` : ""}`;
			else if (kind === "workflow") label = `[Muse] workflow${text(item.scriptId) ? ` · ${text(item.scriptId)}` : ""}`;
			else if (kind === "compaction") label = "[Muse] compaction";
			else if (kind === "reminderChild") label = "[Muse] reminder";
			else label = `[Muse] ${kind}`;
			const suffix = (terminal ? TurnRun.resultSummary(item) : "") || fallback;
			message = `${label} — ${status}${suffix ? `: ${suffix}` : ""}`;
		}
		if (body) message = `${message}\n${body}`;
		if (message === tracked.lastActivity) return;
		tracked.lastActivity = message;
		const delta = `\n\n${message}\n`;
		if (kind === "reasoning") this.onReasoningDelta?.(delta);
		else this.onActivityDelta?.(delta);
	}

	private process(method: string, params: Frame): void {
		if (this.settled) return;
		if (method === "view/gap") {
			const after = text(params.after);
			const next = text(params.next);
			this.diagnostics.push(`Muse view stream dropped events between cursor ${after || "?"} and ${next || "?"}; streamed text may be incomplete, final text is authoritative`);
			this.gapAwaitingLive = true;
			void this.durableCatchUp(1);
			return;
		}
		if (method === "turn/started") {
			// Successor run (`user_successor.run_origin: pure_followup`): the host answers a steer that arrived after this
			// turn's last model call in a fresh run with its own turnId. Adopt it — its deltas/text/terminal are this outcome's.
			const startedTurnId = text(params.turnId);
			if (this.heldTerminal && startedTurnId && startedTurnId !== this.turnId) {
				clearTimeout(this.successorTimer);
				this.successorTimer = undefined;
				this.heldTerminal = undefined;
				this.turnId = startedTurnId;
			}
			if (!startedTurnId || startedTurnId !== this.turnId) return;
			this.onActivityDelta?.("\n\n[Muse] turn started\n");
			return;
		}
		if (method === "item/started" || method === "item/updated" || method === "item/completed") {
			const item = asRecord(params.item);
			const itemId = item ? text(item.itemId) : "";
			const kind = item ? text(item.kind) : "";
			if (!item || !itemId || !kind) return;
			// The steered userMessage settles one outstanding steer whether it lands in this turn (B2) or the successor (B1).
			if (method === "item/completed" && kind === "userMessage" && item.steered === true && this.outstandingSteers > 0) this.outstandingSteers--;
			const existing = this.items.get(itemId);
			const ownerTurnId = typeof item.turnId === "string" ? item.turnId : existing?.turnId;
			if (this.turnId && ownerTurnId !== undefined && ownerTurnId !== this.turnId) return; // another turn's item: never streamed here
			const tracked = existing?.kind === kind ? existing : { kind, turnId: ownerTurnId };
			tracked.kind = kind;
			tracked.turnId = ownerTurnId;
			this.items.set(itemId, tracked);
			if (method === "item/completed" && kind === "agentMessage" && typeof item.text === "string") this.lastAgentText = item.text;
			this.emitItemProgress(method, item, tracked);
			return;
		}
		if (method === "item/delta") {
			const tracked = this.items.get(text(params.itemId));
			if (!tracked) return; // unknown or foreign item: dropped
			const field = typeof params.field === "string" && params.field ? params.field : "text";
			const delta = text(params.delta);
			if (!delta) return;
			if (tracked.kind === "agentMessage" && field === "text") {
				this.onTextDelta?.(delta);
			} else if (tracked.kind === "reasoning" && /^summary\.\d+$/.test(field)) {
				if (tracked.lastDeltaField && tracked.lastDeltaField !== field) this.onReasoningDelta?.("\n\n");
				tracked.lastDeltaField = field;
				this.onReasoningDelta?.(delta);
			}
			// Tool/shell `output` deltas are deliberately not surfaced: the lifecycle labels from emitItemProgress
			// carry the signal, and raw tool output (e.g. a full directory listing) floods the transcript.
			return;
		}
		if (method === "session/tokenUsage") {
			const frame = asRecord(params.usage);
			if (!frame) return;
			if (!this.usage) {
				this.usage = { ...frame };
				return;
			}
			// One frame per model call; a turn (and an adopted successor) may have several. Sum — never last-wins.
			for (const key of ["inputTokens", "outputTokens", "cachedTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) {
				this.usage[key] = numeric(this.usage[key]) + numeric(frame[key]);
			}
			return;
		}
		if (method === "turn/completed") {
			if (this.turnId && text(params.turnId) !== this.turnId) return;
			const error = asRecord(params.error);
			const value: TurnTerminal = {
				terminal: text(params.terminal) || "failed",
				errorText: error ? rpcErrorInfo(error)?.message : undefined,
				interrupted: this.interrupted,
			};
			if (value.terminal === "completed" && this.outstandingSteers > 0 && !this.interrupted) {
				// An accepted steer is still unanswered: the host will mint a successor run. Park the terminal until it
				// completes (adopted in the turn/started branch); resolve as-is if no successor appears in time.
				this.heldTerminal = value;
				this.successorTimer = setTimeout(() => {
					this.successorTimer = undefined;
					const held = this.heldTerminal;
					if (!held) return;
					this.heldTerminal = undefined;
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
		this.terminalResolvers.resolve(value);
	}

	/**
	 * Gap recovery against muse 1.0.2 as observed (msdv_E2/E3): `view/page` serves the DURABLE view — a renumbered
	 * cursor namespace with no `item/delta` — so the live `after`/`next` cursors are not valid page anchors and dropped
	 * deltas are unrecoverable by design. The only facts a hole can cost this run are its authoritative agentMessage
	 * `item/completed` text and its `turn/completed`; both are durable. Page the durable view from its start and apply
	 * exactly those two event kinds; `process()` scopes them to this turn. Live delivery has already resumed at `next`,
	 * so a failed catch-up fails the turn only when no live event has arrived since the gap (the terminal may be in the
	 * hole and unreachable) — never a turn that is demonstrably still streaming.
	 */
	private async durableCatchUp(attempt: number): Promise<void> {
		if (this.catchingUp || this.terminalResolved || this.settled) return;
		this.catchingUp = true;
		try {
			let cursor = "";
			for (let page = 0; page < 50 && !this.terminalResolved; page++) {
				const result = await this.host.request("view/page", { sessionId: this.sessionId, ...(cursor ? { cursor } : {}), direction: "forward", limit: 1000 }, 15_000);
				const events = Array.isArray(result.events) ? result.events : [];
				for (const element of events) {
					const frame = asRecord(element);
					const params = frame ? asRecord(frame.params) : undefined;
					if (!frame || !params) continue;
					const eventMethod = text(frame.method);
					const isFinalText = eventMethod === "item/completed" && asRecord(params.item)?.kind === "agentMessage";
					if (isFinalText || eventMethod === "turn/completed") this.process(eventMethod, params);
					if (this.terminalResolved) break;
				}
				const nextCursor = text(result.nextCursor);
				if (!nextCursor || nextCursor === cursor) break; // `null` = end of the durable view; equal = no progress
				cursor = nextCursor;
			}
		} catch (error) {
			this.catchingUp = false;
			if (this.terminalResolved || this.settled) return;
			if (attempt < 3) {
				this.diagnostics.push(`Muse durable catch-up attempt ${attempt} failed (${errorMessage(error)}); retrying`);
				setTimeout(() => void this.durableCatchUp(attempt + 1), 2_000);
				return;
			}
			if (this.gapAwaitingLive) {
				this.resolveTerminal({ terminal: "failed", errorText: `Muse view gap replay failed (${errorMessage(error)}); turn state lost`, interrupted: false });
			} else {
				this.diagnostics.push(`Muse durable catch-up failed after ${attempt} attempts (${errorMessage(error)}); relying on live delivery`);
			}
			return;
		}
		this.catchingUp = false;
	}

	get finalText(): string {
		return this.lastAgentText;
	}

	get tokenUsage(): Frame | undefined {
		return this.usage;
	}

	async steer(input: Frame[], expectedTurnId?: string, thinkingLevel?: MuseThinkingLevel): Promise<boolean> {
		const turnId = expectedTurnId ?? this.turnId;
		// `interrupted` matters as much as `settled`: during the post-abort grace the run is still registered, and a
		// message typed right after ESC must start a fresh turn instead of being swallowed as a steer.
		if (!turnId || this.settled || this.terminalResolved || this.interrupted) return false;
		const reasoningEffort = museThinkingLevel(thinkingLevel) ?? this.reasoningEffort;
		try {
			await this.host.request("turn/steer", {
				commandId: uuidv7(),
				sessionId: this.sessionId,
				expectedTurnId: turnId,
				input,
				...(reasoningEffort ? { reasoningEffort } : {}),
			}, 10_000);
			this.reasoningEffort = reasoningEffort;
			this.outstandingSteers++;
			return true;
		} catch (error) {
			this.diagnostics.push(`Muse steer did not land (${errorMessage(error)}); input fell through to normal flow`);
			return false;
		}
	}

	markInterrupted(): void {
		this.interrupted = true;
		// After a user abort the run MUST stop depending on a matching terminal. With outstanding steers the host
		// mints successor runs and `turnId` moves, so the interrupted turn's `turn/completed` can arrive under an id
		// this run no longer owns — that is how an ESC left OMP "Working" while the host had already cancelled, and
		// left the run in `activeRuns` so the next message was swallowed as a steer.
		clearTimeout(this.abortTimer);
		this.abortTimer = setTimeout(() => {
			this.abortTimer = undefined;
			if (this.settled || this.terminalResolved) return;
			this.diagnostics.push("Muse did not report a terminal for the interrupted turn; settling it locally as cancelled");
			this.resolveTerminal({ terminal: "cancelled", errorText: undefined, interrupted: true });
		}, ABORT_SETTLE_MS);
	}

	settle(): void {
		this.settled = true;
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
	if (activeHost && !activeHost.dead) return activeHost;
	if (!hostPromise) {
		hostPromise = MuseHost.connect(sandboxed)
			.then((host) => {
				activeHost = host;
				host.onNotification(hostListener);
				host.exitPromise.catch(() => {
					if (activeHost === host) {
						activeHost = null;
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
	hostPromise = null;
	sessionsOnHost.clear();
	activeRuns.clear();
	host?.dispose();
}

/** Tier 2: route user input to whichever Muse turn is currently running in this process. */
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
// Tier 1: host-backed turn runner

export interface MuseTurnArgs {
	sessionId: string;
	/** True when the session already exists (started or exec'd earlier) and must be resumed on this host. */
	resumeExisting: boolean;
	prompt: string;
	/**
	 * The entire first input (OMP system prompt sans tools + post-compaction context + task), used wholesale ONLY
	 * when this call creates the Muse session. Resumed sessions carry their own history, so `prompt` is used as-is
	 * and the task can never be sent twice.
	 */
	initialPrompt?: string;
	modelId: string;
	workspace: string;
	thinkingLevel?: MuseThinkingLevel;
	sandboxed: boolean;
	signal?: AbortSignal;
	onTextDelta?: (delta: string) => void;
	onReasoningDelta?: (delta: string) => void;
	onActivityDelta?: (delta: string) => void;
}

export interface MuseTurnOutcome {
	output: string;
	usage: MuseUsage;
	diagnostics: string[];
	/** Set when the turn failed after admission. */
	errorMessage?: string;
	aborted?: boolean;
}

const EMPTY_USAGE: MuseUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

/** Outcome for a turn the caller cancelled before the host admitted it: nothing ran, nothing to fall back to. */
function abortedBeforeAdmission(run: TurnRun): MuseTurnOutcome {
	return { output: "", usage: { ...EMPTY_USAGE }, diagnostics: run.diagnostics, aborted: true, errorMessage: "Muse turn was interrupted" };
}

function mapUsage(usage: Frame | undefined): MuseUsage {
	if (!usage) return { ...EMPTY_USAGE };
	return {
		input: numeric(usage.inputTokens),
		output: numeric(usage.outputTokens),
		cacheRead: numeric(usage.cacheReadTokens) || numeric(usage.cachedTokens),
		cacheWrite: numeric(usage.cacheWriteTokens),
		cost: 0,
		contextTokens: 0,
		turns: 1,
	};
}

/**
 * Run one turn on the persistent `muse serve` host.
 * Throws HostUnavailableError for anything that fails before the turn is admitted,
 * letting the caller fall back to the proven exec path; host failures after
 * admission return an outcome with errorMessage/aborted set.
 */
export async function runMuseTurn(args: MuseTurnArgs): Promise<MuseTurnOutcome> {
	const host = await ensureHost(args.sandboxed);
	const run = new TurnRun(host, args.sessionId, args.onTextDelta, args.onReasoningDelta, args.onActivityDelta, args.thinkingLevel);
	let admitted = false;

	const abortHandler = () => {
		run.markInterrupted();
		host.request(
			"turn/interrupt",
			{ commandId: uuidv7(), sessionId: args.sessionId, ...(run.turnId ? { turnId: run.turnId } : {}) },
			10_000,
		).catch(() => {});
	};

	if (args.signal?.aborted) return abortedBeforeAdmission(run);
	const turnCommand = uuidv7();
	// Fresh turn: turnId == commandId (WIRE.md; every ack in msdv_B1/B2/C1b/C3). Own the id before ANY frame can
	// arrive: session/resume of a session orphaned by host death emits its `cancelled` terminal
	// (resume_reconcile:orphaned_by_process_loss) while session/resume or session/setModel is still pending — before
	// turn/start is ever sent — so allocating the id only at turn/start still lets that orphan resolve the run.
	run.turnId = turnCommand;
	activeRuns.set(args.sessionId, run);
	let createdSession = false;
	try {
		const alreadyLoaded = sessionsOnHost.get(args.sessionId) === host;
		const museModelId = resolveMuseModelId(args.modelId);
		if (!alreadyLoaded) {
			const startParams: Frame = { commandId: uuidv7(), sessionId: args.sessionId, workspaceRoot: args.workspace, approvalMode: "allowAll", modelId: museModelId };
			const resumeParams: Frame = { commandId: uuidv7(), sessionId: args.sessionId };
			let openedWithStart = !args.resumeExisting;
			let opened: Frame;
			try {
				if (args.resumeExisting) opened = await host.request("session/resume", resumeParams, 20_000);
				else opened = await host.request("session/start", startParams, 20_000);
			} catch (error) {
				const kind = error instanceof MspRequestError ? error.kind : undefined;
				const sessionAlreadyExists = kind === "sessionInUse" ||
					kind === "invalidParams" ||
					kind === "sessionNotFound" ||
					(kind === "commandRejected" && /already exists or is reserved/i.test(errorMessage(error)));
				if (!args.resumeExisting && sessionAlreadyExists) {
					opened = await host.request("session/resume", { ...resumeParams, commandId: uuidv7() }, 20_000);
					openedWithStart = false;
				} else if (args.resumeExisting && kind === "sessionNotFound") {
					opened = await host.request("session/start", { ...startParams, commandId: uuidv7() }, 20_000);
					openedWithStart = true;
				} else {
					throw new HostUnavailableError(`Muse host could not open session ${args.sessionId}: ${errorMessage(error)}`, error);
				}
			}
			// An empty `viewCursor` means the host will stream no view notifications for this session (observed on
			// muse 1.0.3 resuming sessions it did not just create). The turn would run and settle durably while this
			// client waited forever, so refuse before admission and let the caller take the exec fallback instead.
			if (!text(opened.viewCursor)) {
				throw new HostUnavailableError(`Muse host opened session ${args.sessionId} without a live view stream (empty viewCursor); refusing to run a turn it cannot observe`);
			}
			sessionsOnHost.set(args.sessionId, host);
			createdSession = openedWithStart;
			if (openedWithStart) sessionModelOnHost.set(args.sessionId, museModelId);
		}
		if (sessionModelOnHost.get(args.sessionId) !== museModelId) {
			await host.request("session/setModel", { commandId: uuidv7(), sessionId: args.sessionId, model: { modelId: museModelId } }, 20_000);
			sessionModelOnHost.set(args.sessionId, museModelId);
		}
		// A cancel that lands while session/start|resume or setModel was in flight is a user decision, not a host
		// failure: report it as an interrupted turn so streamMuse never falls back to `muse exec` for it.
		if (args.signal?.aborted) return abortedBeforeAdmission(run);
		// Use the caller's initial prompt only for a session this call actually created: the OMP transcript cannot
		// tell whether the Muse-side session still exists (a deleted backend session leaves prior muse-code
		// assistant entries behind), so the start-vs-resume outcome is the only sound signal for "no history yet".
		// Selected wholesale — never concatenated — so the task cannot appear twice.
		const firstInput = createdSession && args.initialPrompt ? args.initialPrompt : args.prompt;
		const ack = await host.request("turn/start", {
			commandId: turnCommand,
			sessionId: args.sessionId,
			input: [{ type: "text", text: firstInput }],
			...(args.thinkingLevel ? { reasoningEffort: museThinkingLevel(args.thinkingLevel) } : {}),
		}, 20_000);
		run.turnId = text(ack.turnId) || turnCommand;
		admitted = true;
		if (args.signal) args.signal.addEventListener("abort", abortHandler, { once: true });
		if (args.signal?.aborted) abortHandler();

		// Race the turn against host death: `run.terminal` is not a pending request, so
		// a `muse serve` crash after admission would otherwise await forever. Registry
		// cleanup (activeHost/sessionsOnHost) happens in ensureHost's exitPromise catch;
		// this yields the admitted-turn error (no exec fallback: the turn already ran).
		const terminal = await Promise.race([
			run.terminal,
			host.exitPromise.then((never_): TurnTerminal => {
				void never_;
				return { terminal: "failed", errorText: "muse serve exited during turn", interrupted: false };
			}),
		]);
		const usage = mapUsage(run.tokenUsage);
		if (args.signal?.aborted || terminal.interrupted || terminal.terminal === "cancelled") {
			return { output: run.finalText, usage, diagnostics: run.diagnostics, aborted: true, errorMessage: "Muse turn was interrupted" };
		}
		if (terminal.terminal !== "completed") {
			return { output: run.finalText, usage, diagnostics: run.diagnostics, errorMessage: terminal.errorText ?? `Muse turn ended: ${terminal.terminal}` };
		}
		return { output: run.finalText, usage, diagnostics: run.diagnostics };
	} catch (error) {
		if (!admitted) {
			if (args.signal?.aborted) return abortedBeforeAdmission(run);
			throw error instanceof HostUnavailableError ? error : new HostUnavailableError(`Muse host turn failed before admission: ${errorMessage(error)}`, error);
		}
		return {
			output: run.finalText,
			usage: mapUsage(run.tokenUsage),
			diagnostics: run.diagnostics,
			errorMessage: errorMessage(error),
			aborted: args.signal?.aborted === true,
		};
	} finally {
		run.settle();
		if (args.signal) args.signal.removeEventListener("abort", abortHandler);
		if (activeRuns.get(args.sessionId) === run) activeRuns.delete(args.sessionId);
	}
}
