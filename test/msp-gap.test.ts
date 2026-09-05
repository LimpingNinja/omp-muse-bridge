import { expect, test } from "bun:test";
import { TurnRun } from "../src/msp.ts";
import type { Frame, MuseRequester } from "../src/msp.ts";

/** Live deltas and durable completions use independent cursors; recovery must preserve turn ownership. */

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
const durableText = (turnId: string, text: string, viewCursor: string, itemId = "item-1"): Frame => ({ sessionId: "session-1", viewCursor, item: { itemId, kind: "agentMessage", turnId, status: "completed", text } });
const durableTerminal = (turnId: string, viewCursor: string): Frame => ({ sessionId: "session-1", viewCursor, turnId, terminal: "completed" });

test("a gap that swallowed the terminal is closed from the durable view", async () => {
	let streamed = "";
	const snapshots: Frame[] = [];
	const host = fakeHost();
	const run = new TurnRun({
		host,
		sessionId: "session-1",
		onTextDelta: (d) => {
			streamed += d;
		},
		onTextSnapshot: (itemId, snapshot) => snapshots.push({ itemId, snapshot }),
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
		nextCursor: null,
	});

	const terminal = await run.terminal;
	expect(terminal.terminal).toBe("completed");
	expect(run.finalText).toBe("abxyz"); // authoritative text recovered
	expect(snapshots).toEqual([{ itemId: "item-1", snapshot: "abxyz" }]);
	expect(streamed).toBe("ab"); // dropped deltas are unrecoverable by design
	run.settle();
});

test("failed recovery does not terminate a turn whose live stream resumed", async () => {
	const host: MuseRequester = { request: () => Promise.reject(new Error("durable view unavailable")) };
	const run = new TurnRun({ host, sessionId: "session-1" });
	run.turnId = "turn-1";
	try {
		let resolved = false;
		void run.terminal.then(() => { resolved = true; });
		run.handleNotification("view/gap", { sessionId: "session-1", after: "c5", next: "c9" });
		run.handleNotification("item/started", started("turn-1"));
		await run.drainCatchUp();
		expect(resolved).toBe(false);
		run.handleNotification("item/completed", durableText("turn-1", "live", "c9"));
		run.handleNotification("turn/completed", durableTerminal("turn-1", "c10"));
		expect((await run.terminal).terminal).toBe("completed");
		expect(run.finalText).toBe("live");
	} finally {
		run.settle();
	}
}, 10_000);

test("another turn's durable events are not applied during catch-up", async () => {
	const host = fakeHost();
	const run = new TurnRun({ host, sessionId: "session-1" });
	run.turnId = "turn-2";

	run.handleNotification("view/gap", { sessionId: "session-1", after: "c30", next: "c34" });
	host.resolvePage(0, {
		events: [
			{ method: "item/completed", params: durableText("turn-1", "OLD", "d4") },
			{ method: "turn/completed", params: durableTerminal("turn-1", "d6") },
			{ method: "turn/completed", params: durableTerminal("turn-2", "d9") },
		],
		nextCursor: null,
	});

	const terminal = await run.terminal;
	expect(terminal.terminal).toBe("completed");
	expect(run.finalText).toBe(""); // "OLD" belongs to turn-1
	run.settle();
});

test("a live terminal published while catch-up is pending still yields the recovered text before drain", async () => {
	// Regression: the terminal arrives live while the durable page is still in flight. The turn resolves from the
	// live stream (never held hostage to the page), and when the page later arrives the recovered item completion
	// is applied and observable — the outcome builder drains in-flight catch-up before reading the result.
	const snapshots: Frame[] = [];
	const host = fakeHost();
	const run = new TurnRun({
		host,
		sessionId: "session-1",
		onTextSnapshot: (itemId, snapshot) => snapshots.push({ itemId, snapshot }),
	});
	run.turnId = "turn-1";

	run.handleNotification("view/gap", { sessionId: "session-1", after: "c1", next: "c5" });
	expect(host.pageRequests).toHaveLength(1); // catch-up is in flight, page unresolved

	// The live terminal wins the race: the run resolves without waiting for the page.
	run.handleNotification("turn/completed", durableTerminal("turn-1", "c5"));
	const terminal = await run.terminal;
	expect(terminal.terminal).toBe("completed");
	expect(run.finalText).toBe(""); // the item completion is only in the durable hole so far

	// The page lands after the live terminal: the recovered text is applied, not discarded.
	host.resolvePage(0, {
		events: [{ method: "item/completed", params: durableText("turn-1", "RECOVERED", "d1") }],
		nextCursor: null,
	});
	await run.drainCatchUp();
	expect(run.finalText).toBe("RECOVERED");
	expect(snapshots).toEqual([{ itemId: "item-1", snapshot: "RECOVERED" }]);
	run.settle();
});

test("malformed durable events do not discard valid completions in the same page", async () => {
	const host = fakeHost();
	const run = new TurnRun({ host, sessionId: "session-1" });
	run.turnId = "turn-1";

	run.handleNotification("view/gap", { sessionId: "session-1", after: "c1", next: "c2" });
	// External input the narrowing must survive: non-object events, events with no method, junk nextCursor.
	host.resolvePage(0, {
		events: [42, { params: {} }, { method: 7, params: {} }, { method: "item/completed", params: durableText("turn-1", "ok", "d1") }],
		nextCursor: null,
	});

	// The well-formed recovered text still lands; the run is then finished by its live terminal.
	run.handleNotification("turn/completed", durableTerminal("turn-1", "c2"));
	const terminal = await run.terminal;
	expect(terminal.terminal).toBe("completed");
	await run.drainCatchUp();
	expect(run.finalText).toBe("ok");
	run.settle();
});

test("multiple completed agent items accumulate into the final transcript in arrival order", async () => {
	const host = fakeHost();
	const run = new TurnRun({ host, sessionId: "session-1" });
	run.turnId = "turn-1";

	run.handleNotification("item/completed", durableText("turn-1", "early answer", "c1", "item-a"));
	run.handleNotification("item/completed", durableText("turn-1", "main answer", "c2", "item-b"));
	run.handleNotification("turn/completed", durableTerminal("turn-1", "c3"));

	const terminal = await run.terminal;
	expect(terminal.terminal).toBe("completed");
	expect(run.finalText).toBe("early answermain answer");
	run.settle();
});

test("usage totals favor the server counted-once derivations and normalize uncached input", async () => {
	const host = fakeHost();
	const run = new TurnRun({ host, sessionId: "session-1" });
	run.turnId = "turn-1";

	run.handleNotification("session/tokenUsage", {
		sessionId: "session-1",
		viewCursor: "c1",
		turnId: "turn-1",
		promptTokens: 100,
		totalTokens: 140,
		usage: { inputTokens: 90, outputTokens: 40, cachedTokens: 60, cacheReadTokens: 60, cacheWriteTokens: 10, reasoningTokens: 5 },
		cumulative: { promptTokens: 100, outputTokens: 40, totalTokens: 140 },
	});
	run.handleNotification("session/tokenUsage", {
		sessionId: "session-1",
		viewCursor: "c2",
		turnId: "turn-1",
		promptTokens: 100,
		totalTokens: 170,
		usage: { inputTokens: 95, outputTokens: 70, cachedTokens: 60, cacheReadTokens: 60, cacheWriteTokens: 10, reasoningTokens: 5 },
		cumulative: { promptTokens: 200, outputTokens: 110, totalTokens: 310 },
	});
	run.handleNotification("session/contextUsage", { sessionId: "session-1", usedTokens: 240 });
	run.handleNotification("turn/completed", durableTerminal("turn-1", "c3"));
	await run.terminal;

	const usage = run.tokenUsage;
	expect(usage).toBeDefined();
	// Counted-once: prompt 100 includes 70 cached, so uncached input is 30 per completion; totals sum verbatim.
	expect(usage?.input).toBe(60);
	expect(usage?.output).toBe(110);
	expect(usage?.cacheRead).toBe(120);
	expect(usage?.cacheWrite).toBe(20);
	expect(usage?.totalTokens).toBe(310);
	expect(usage?.contextTokens).toBe(240);
	expect(usage?.turns).toBe(2);
	run.settle();
});

test("usage falls back to raw counters when the counted-once derivations are absent", async () => {
	const host = fakeHost();
	const run = new TurnRun({ host, sessionId: "session-1" });
	run.turnId = "turn-1";

	run.handleNotification("session/tokenUsage", {
		sessionId: "session-1",
		viewCursor: "c1",
		turnId: "turn-1",
		usage: { inputTokens: 50, outputTokens: 20, cachedTokens: 15, cacheWriteTokens: 5, reasoningTokens: 0 },
	});
	run.handleNotification("turn/completed", durableTerminal("turn-1", "c2"));
	await run.terminal;

	const usage = run.tokenUsage;
	// Without counted-once totals, preserve the raw counters rather than guessing cache overlap.
	expect(usage?.input).toBe(50);
	expect(usage?.totalTokens).toBe(90);

	// An explicit prompt total can never produce negative uncached input.
	const clampedRun = new TurnRun({ host, sessionId: "session-1" });
	clampedRun.turnId = "turn-1";
	clampedRun.handleNotification("session/tokenUsage", {
		sessionId: "session-1",
		viewCursor: "c1",
		turnId: "turn-1",
		usage: { inputTokens: 5, outputTokens: 3, cachedTokens: 900, reasoningTokens: 0 },
		promptTokens: 5,
		totalTokens: 8,
	});
	expect(clampedRun.tokenUsage?.input).toBe(0);
	clampedRun.settle();
	run.settle();
});
