import { expect, test } from "bun:test";
import { TurnRun, type Frame, type MuseRequester } from "../src/msp.ts";

/**
 * Gap replay contract (msp.schema.json ViewGapParams/ViewPageResult):
 * cursors are opaque strings compared only by equality; live delivery resumes AT
 * `next`; the hole is the open interval (after, next); forward `nextCursor` equals
 * the last event's cursor (never skips); the boundary event at cursor == next is
 * discarded; buffered live events drain after the hole, in arrival order, exactly
 * once. Deterministic: the fake host hands out per-request resolvers plus
 * `nextRequest(n)`, which resolves the moment request n+1 is issued — no timers.
 */

interface FakeHost extends MuseRequester {
	pages: Array<(result: Frame) => void>;
	pageRequests: Frame[];
	nextRequest(index: number): Promise<void>;
}

function fakeHost(): FakeHost {
	const host = {
		pages: [] as Array<(result: Frame) => void>,
		pageRequests: [] as Frame[],
		waiters: [] as Array<{ index: number; resolve: () => void }>,
		request(method: string, params: Frame): Promise<Frame> {
			if (method === "view/page") {
				host.pageRequests.push(params);
				const p = new Promise<Frame>((resolve) => host.pages.push(resolve));
				for (const waiter of host.waiters.filter((w) => host.pages.length > w.index)) waiter.resolve();
				host.waiters = host.waiters.filter((w) => host.pages.length <= w.index);
				return p;
			}
			return Promise.resolve({});
		},
		nextRequest(index: number): Promise<void> {
			return host.pages.length > index ? Promise.resolve() : new Promise((resolve) => host.waiters.push({ index, resolve }));
		},
	};
	return host;
}

const delta = (text: string, viewCursor: string): Frame => ({ itemId: "item-1", delta: text, field: "text", viewCursor, sessionId: "session-1" });
// Schema-valid page: nextCursor is the LAST event's cursor.
const page = (events: Array<[string, string]>): Frame => ({
	events: events.map(([deltaText, viewCursor]) => ({ method: "item/delta", params: delta(deltaText, viewCursor) })),
	...(events.length > 0 ? { nextCursor: events[events.length - 1][1] } : {}),
});

test("gap splice-fill replays hole, discards boundary, drains live exactly once", async () => {
	let streamed = "";
	const host = fakeHost();
	const run = new TurnRun(host, "session-1", (d) => {
		streamed += d;
	});
	run.turnId = "turn-1";

	run.handleNotification("item/started", { sessionId: "session-1", viewCursor: "c10", item: { itemId: "item-1", kind: "agentMessage", status: "inProgress" } });
	run.handleNotification("item/delta", delta("a", "c11"));
	run.handleNotification("item/delta", delta("b", "c12"));
	run.handleNotification("view/gap", { sessionId: "session-1", after: "c12", next: "c16" });

	// Live resumes at `next` while replay is still in flight: must buffer, not stream.
	run.handleNotification("item/delta", delta("d", "c16"));
	run.handleNotification("turn/completed", { sessionId: "session-1", viewCursor: "c17", turnId: "turn-1", terminal: "completed" });
	expect(streamed).toBe("ab");

	// Hole (c12, c16): x + c; the c16 boundary copy is discarded — the buffered live d is authoritative.
	host.pages[0](page([["x", "c13"], ["c", "c14"], ["DUP", "c16"]]));
	const terminal = await run.terminal;

	expect(streamed).toBe("abxcd"); // hole spliced in cursor order, DUP dropped, d once from the buffer
	expect(terminal.terminal).toBe("completed");
	expect(host.pageRequests).toHaveLength(1);
	expect(host.pageRequests[0]?.cursor).toBe("c12"); // exclusive anchor = gap.after
});

test("nested gaps chain serially through the drain", async () => {
	let streamed = "";
	const host = fakeHost();
	const run = new TurnRun(host, "session-1", (d) => {
		streamed += d;
	});
	run.turnId = "turn-1";

	run.handleNotification("item/started", { sessionId: "session-1", viewCursor: "c10", item: { itemId: "item-1", kind: "agentMessage", status: "inProgress" } });
	run.handleNotification("item/delta", delta("a", "c11"));
	run.handleNotification("view/gap", { sessionId: "session-1", after: "c11", next: "c20" });
	// Second gap arrives during the first recovery: buffered, not processed concurrently.
	run.handleNotification("view/gap", { sessionId: "session-1", after: "c20", next: "c30" });
	run.handleNotification("turn/completed", { sessionId: "session-1", viewCursor: "c31", turnId: "turn-1", terminal: "completed" });

	// Gap 1 spans two pages: hole deltas, then a page carrying the c20 boundary (discarded).
	host.pages[0](page([["x", "c12"], ["y", "c13"]]));
	await host.nextRequest(1);
	expect(host.pageRequests[1]?.cursor).toBe("c13"); // pagination advanced by last event's cursor
	host.pages[1](page([["LIVE", "c20"]]));

	// Only now may gap 2 start its own replay from c20.
	await host.nextRequest(2);
	expect(host.pageRequests[2]?.cursor).toBe("c20");
	host.pages[2](page([["z", "c21"]]));
	await host.nextRequest(3);
	host.pages[3](page([["LIVE", "c30"]])); // gap-2 boundary

	const terminal = await run.terminal;
	expect(streamed).toBe("axyz"); // both LIVE boundary copies dropped
	expect(terminal.terminal).toBe("completed");
	// Gap 2 pages from its own last event cursor (c21), not from `next` — pagination
	// advances strictly by returned cursors until the c30 boundary page comes back.
	expect(host.pageRequests.map((request) => request.cursor)).toEqual(["c11", "c13", "c20", "c21"]);
});

test("unreplayable gap fails the turn instead of hanging", async () => {
	const host = fakeHost();
	const run = new TurnRun(host, "session-1", () => {});
	run.turnId = "turn-1";

	run.handleNotification("view/gap", { sessionId: "session-1", after: "c5", next: "c9" });
	host.pages[0]({ events: [], nextCursor: "c5" }); // empty page, no progress toward c9
	const terminal = await run.terminal;
	expect(terminal.terminal).toBe("failed");
	expect(terminal.errorText).toContain("gap");
});
