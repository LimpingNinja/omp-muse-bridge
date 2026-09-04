import { expect, test } from "bun:test";
import { TurnRun, type Frame, type MuseRequester } from "../src/msp.ts";

/**
 * Gap recovery contract as muse 1.0.3 actually behaves (see WIRE.md "Gap strategy"):
 * `view/page` serves the DURABLE view — its own cursor namespace, no `item/delta` — so live `after`/`next` cursors
 * are not page anchors and dropped deltas are unrecoverable. A gap therefore must never fail a turn that is still
 * streaming; the recoverable facts are the authoritative `agentMessage` text and the `turn/completed` terminal.
 * The fake host hands out per-request resolvers, so every test is deterministic with no timers.
 */

interface FakeHost extends MuseRequester {
	pageRequests: Frame[];
	resolvePage(index: number, result: Frame): void;
	rejectPage(index: number, error: Error): void;
}

function fakeHost(): FakeHost {
	const resolvers: Array<{ resolve: (value: Frame) => void; reject: (error: unknown) => void }> = [];
	const pageRequests: Frame[] = [];
	return {
		pageRequests,
		request(method: string, params: Frame): Promise<Frame> {
			if (method !== "view/page") return Promise.resolve({});
			pageRequests.push(params);
			const { promise, resolve, reject } = Promise.withResolvers<Frame>();
			resolvers.push({ resolve, reject });
			return promise;
		},
		resolvePage(index: number, result: Frame): void {
			resolvers[index]?.resolve(result);
		},
		rejectPage(index: number, error: Error): void {
			resolvers[index]?.reject(error);
		},
	};
}

const delta = (text: string, viewCursor: string): Frame => ({ itemId: "item-1", delta: text, field: "text", viewCursor, sessionId: "session-1" });
const started = (turnId: string): Frame => ({ sessionId: "session-1", viewCursor: "c10", item: { itemId: "item-1", kind: "agentMessage", turnId, status: "inProgress" } });
const durableText = (turnId: string, text: string, viewCursor: string): Frame => ({ sessionId: "session-1", viewCursor, item: { itemId: "item-1", kind: "agentMessage", turnId, status: "completed", text } });
const durableTerminal = (turnId: string, viewCursor: string): Frame => ({ sessionId: "session-1", viewCursor, turnId, terminal: "completed" });

test("a gap that swallowed the terminal is closed from the durable view", async () => {
	let streamed = "";
	const host = fakeHost();
	const run = new TurnRun(host, "session-1", (d) => {
		streamed += d;
	});
	run.turnId = "turn-1";

	run.handleNotification("item/started", started("turn-1"));
	run.handleNotification("item/delta", delta("ab", "c11"));
	// The hole holds this turn's item/completed and its turn/completed.
	run.handleNotification("view/gap", { sessionId: "session-1", after: "c11", next: "c20" });

	expect(host.pageRequests).toHaveLength(1);
	expect(host.pageRequests[0]?.cursor).toBeUndefined(); // durable view is paged from its start, never a live cursor
	host.resolvePage(0, {
		events: [
			{ method: "turn/started", params: { sessionId: "session-1", viewCursor: "d1", turnId: "turn-1" } },
			{ method: "item/completed", params: durableText("turn-1", "abxyz", "d2") },
			{ method: "turn/completed", params: durableTerminal("turn-1", "d3") },
		],
		nextCursor: "d3",
	});

	const terminal = await run.terminal;
	expect(terminal.terminal).toBe("completed");
	expect(run.finalText).toBe("abxyz"); // authoritative text recovered
	expect(streamed).toBe("ab"); // dropped deltas are unrecoverable by design
	run.settle();
});

test("a gap on a still-live turn never fails it, even when paging errors", async () => {
	const host = fakeHost();
	const run = new TurnRun(host, "session-1");
	run.turnId = "turn-1";

	run.handleNotification("view/gap", { sessionId: "session-1", after: "c5", next: "c9" });
	host.rejectPage(0, new Error("unknown cursor anchor"));

	// Live delivery is still flowing: the turn completes from the live stream.
	run.handleNotification("item/started", started("turn-1"));
	run.handleNotification("item/completed", durableText("turn-1", "live", "c9"));
	run.handleNotification("turn/completed", durableTerminal("turn-1", "c10"));

	const terminal = await run.terminal;
	expect(terminal.terminal).toBe("completed");
	expect(run.finalText).toBe("live");
	expect(run.diagnostics.some((entry) => entry.includes("dropped events"))).toBe(true);
	run.settle();
});

test("another turn's durable events are not applied during catch-up", async () => {
	const host = fakeHost();
	const run = new TurnRun(host, "session-1");
	run.turnId = "turn-2";

	run.handleNotification("view/gap", { sessionId: "session-1", after: "c30", next: "c34" });
	host.resolvePage(0, {
		events: [
			{ method: "item/completed", params: durableText("turn-1", "OLD", "d4") },
			{ method: "turn/completed", params: durableTerminal("turn-1", "d6") },
			{ method: "turn/completed", params: durableTerminal("turn-2", "d9") },
		],
		nextCursor: "d9",
	});

	const terminal = await run.terminal;
	expect(terminal.terminal).toBe("completed");
	expect(run.finalText).toBe(""); // "OLD" belongs to turn-1
	run.settle();
});
