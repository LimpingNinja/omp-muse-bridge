import { expect, test } from "bun:test";
import { TurnRun, type Frame, type MuseRequester, type MuseTodoEntry } from "../src/msp.ts";

/**
 * Contracts that protect the user's input from the bridge:
 * a run parked in the successor hold is NOT steerable (that window swallowed messages meant for new turns), and
 * activity reporting names the tool and target without leaking raw tool output.
 */

function acceptingHost(): MuseRequester {
	return { request: (): Promise<Frame> => Promise.resolve({}) };
}

const toolItem = (id: string, tool: string, args: string, status: string): Frame => ({
	sessionId: "session-1",
	item: { itemId: id, kind: "toolCall", turnId: "turn-1", status, tool, args },
});

test("a run parked in the successor hold refuses to steer", async () => {
	const run = new TurnRun(acceptingHost(), "session-1");
	run.turnId = "turn-1";

	// First steer lands while the turn is live.
	expect(await run.steer([{ type: "text", text: "first" }])).toBe(true);

	// The turn completes with that steer unanswered: the terminal is parked awaiting a successor run.
	run.handleNotification("turn/completed", { sessionId: "session-1", turnId: "turn-1", terminal: "completed" });

	// A message typed in that window must become a new turn, never a steer.
	expect(await run.steer([{ type: "text", text: "second" }])).toBe(false);
	run.settle();
});

test("an interrupted run refuses to steer even before it settles", async () => {
	const run = new TurnRun(acceptingHost(), "session-1");
	run.turnId = "turn-1";
	run.markInterrupted();
	expect(await run.steer([{ type: "text", text: "after escape" }])).toBe(false);
	run.settle();
});

test("a steered userMessage clears the hold so the next terminal resolves immediately", async () => {
	const run = new TurnRun(acceptingHost(), "session-1");
	run.turnId = "turn-1";
	expect(await run.steer([{ type: "text", text: "redirect" }])).toBe(true);

	run.handleNotification("item/completed", {
		sessionId: "session-1",
		item: { itemId: "u1", kind: "userMessage", turnId: "turn-1", status: "completed", steered: true, text: "redirect" },
	});
	run.handleNotification("turn/completed", { sessionId: "session-1", turnId: "turn-1", terminal: "completed" });

	const terminal = await run.terminal;
	expect(terminal.terminal).toBe("completed");
	run.settle();
});

test("tool activity names the tool and its target, and reports no raw output", () => {
	const activity: string[] = [];
	const run = new TurnRun(acceptingHost(), "session-1", undefined, undefined, (delta) => activity.push(delta.trim()));
	run.turnId = "turn-1";

	run.handleNotification("item/started", toolItem("t1", "edit_file", JSON.stringify({ path: "src/models.py" }), "inProgress"));
	run.handleNotification("item/completed", {
		sessionId: "session-1",
		item: { itemId: "t1", kind: "toolCall", turnId: "turn-1", status: "completed", tool: "edit_file", args: JSON.stringify({ path: "src/models.py" }), visibleOutput: "SECRET FILE CONTENTS SHOULD NOT APPEAR" },
	});

	expect(activity[0]).toBe("**[Muse]** → called `edit_file` on `src/models.py`");
	expect(activity[1]).toBe("**[Muse]** ✓ `edit_file` finished on `src/models.py`");
	expect(activity.join("\n")).not.toContain("SECRET FILE CONTENTS");
	run.settle();
});

test("todo calls are hidden and delivered as a structured snapshot", () => {
	const activity: string[] = [];
	const snapshots: MuseTodoEntry[][] = [];
	const run = new TurnRun(
		acceptingHost(),
		"session-1",
		undefined,
		undefined,
		(delta) => activity.push(delta.trim()),
		undefined,
		(entries) => snapshots.push(entries),
	);
	run.turnId = "turn-1";

	run.handleNotification("item/started", toolItem("t2", "write_todos", JSON.stringify({
		items: [{ text: "Stage repo", status: "in_progress" }, { text: "Push", status: "pending" }],
	}), "inProgress"));

	expect(snapshots).toEqual([[
		{ label: "Stage repo", status: "in_progress" },
		{ label: "Push", status: "pending" },
	]]);
	expect(activity).toEqual([]); // the call itself is never printed
	run.settle();
});

test("web sources report one label-shaped host per site, whatever punctuation trails the URL", () => {
	const activity: string[] = [];
	const run = new TurnRun(acceptingHost(), "session-1", undefined, undefined, (delta) => activity.push(delta.trim()));
	run.turnId = "turn-1";

	run.handleNotification("item/completed", {
		sessionId: "session-1",
		item: {
			itemId: "t3",
			kind: "toolCall",
			turnId: "turn-1",
			status: "completed",
			tool: "web_search",
			args: JSON.stringify({ query: "oh-my-pi plugin manager" }),
			// Markdown emphasis, a Markdown link, a sentence period and a duplicate: every one of these produced a
			// bogus extra "host" (`omp.sh)**`) or a duplicate before the URL match was delimiter-aware.
			visibleOutput: "**[omp](https://omp.sh)** and https://omp.sh/docs plus [bun](https://bun.sh), then https://pi.dev.",
		},
	});

	expect(activity).toEqual(["**[Muse]** ✓ `web_search` finished on `oh-my-pi plugin manager` — sources: omp.sh, bun.sh, pi.dev"]);
	run.settle();
});
