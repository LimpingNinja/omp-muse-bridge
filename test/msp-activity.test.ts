import { expect, test } from "bun:test";
import { TurnRun } from "../src/msp.ts";
import type { Frame, MuseRequester, MuseTodoEntry } from "../src/msp.ts";

function acceptingHost(): MuseRequester {
	return { request: (): Promise<Frame> => Promise.resolve({}) };
}

const toolItem = (id: string, tool: string, args: string, status: string): Frame => ({
	sessionId: "session-1",
	item: { itemId: id, kind: "toolCall", turnId: "turn-1", status, tool, args },
});

test("a run parked in the successor hold refuses to steer", async () => {
	const run = new TurnRun({ host: acceptingHost(), sessionId: "session-1" });
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
	const run = new TurnRun({ host: acceptingHost(), sessionId: "session-1" });
	run.turnId = "turn-1";
	run.markInterrupted();
	expect(await run.steer([{ type: "text", text: "after escape" }])).toBe(false);
	run.settle();
});

test("a steered userMessage clears the hold so the next terminal resolves immediately", async () => {
	const run = new TurnRun({ host: acceptingHost(), sessionId: "session-1" });
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

test("a userMessage consumed before the steer continuation cannot rearm its hold", async () => {
	const ack = Promise.withResolvers<Frame>();
	const run = new TurnRun({ host: { request: () => ack.promise }, sessionId: "session-1" });
	run.turnId = "turn-1";
	try {
		const steering = run.steer([{ type: "text", text: "redirect" }]);
		ack.resolve({});
		run.handleNotification("item/completed", {
			sessionId: "session-1",
			item: { itemId: "u1", kind: "userMessage", turnId: "turn-1", status: "completed", steered: true, text: "redirect" },
		});
		expect(await steering).toBe(true);
		let resolved = false;
		void run.terminal.then(() => { resolved = true; });
		run.handleNotification("turn/completed", { sessionId: "session-1", turnId: "turn-1", terminal: "completed" });
		await Promise.resolve();
		expect(resolved).toBe(true);
	} finally {
		run.settle();
	}
});

test("an acknowledgement batched with the parent terminal preserves the successor answer", async () => {
	const ack = Promise.withResolvers<Frame>();
	const run = new TurnRun({ host: { request: () => ack.promise }, sessionId: "session-1" });
	run.turnId = "turn-1";
	try {
		const steering = run.steer([{ type: "text", text: "redirect" }]);
		ack.resolve({});
		run.handleNotification("turn/completed", { sessionId: "session-1", turnId: "turn-1", terminal: "completed" });
		expect(await steering).toBe(true);
		let resolved = false;
		void run.terminal.then(() => { resolved = true; });
		await Promise.resolve();
		expect(resolved).toBe(false);
		run.handleNotification("turn/started", { sessionId: "session-1", turnId: "successor" });
		run.handleNotification("item/completed", {
			sessionId: "session-1",
			item: { itemId: "u1", kind: "userMessage", turnId: "successor", status: "completed", steered: true },
		});
		run.handleNotification("item/completed", {
			sessionId: "session-1",
			item: { itemId: "answer", kind: "agentMessage", turnId: "successor", status: "completed", text: "redirected answer" },
		});
		run.handleNotification("turn/completed", { sessionId: "session-1", turnId: "successor", terminal: "completed" });
		expect((await run.terminal).terminal).toBe("completed");
		expect(run.finalText).toBe("redirected answer");
	} finally {
		run.settle();
	}
});

test("a rejected steer releases no hold the next terminal must outwait", async () => {
	// The steer is rejected after its latch was armed, then the turn completes. Nothing was queued, so the
	// completed terminal must resolve immediately — not park for a successor grace on a steer that never landed.
	const rejectingHost: MuseRequester = { request: (): Promise<Frame> => Promise.reject(new Error("command rejected")) };
	const run = new TurnRun({ host: rejectingHost, sessionId: "session-1" });
	run.turnId = "turn-1";

	expect(await run.steer([{ type: "text", text: "redirect" }])).toBe(false);
	run.handleNotification("turn/completed", { sessionId: "session-1", turnId: "turn-1", terminal: "completed" });

	const terminal = await run.terminal;
	expect(terminal.terminal).toBe("completed");
	run.settle();
});

test("tool activity names the tool and its target, and reports no raw output", () => {
	const activity: string[] = [];
	const run = new TurnRun({ host: acceptingHost(), sessionId: "session-1", onActivityDelta: (delta) => activity.push(delta.trim()) });
	run.turnId = "turn-1";

	run.handleNotification("item/started", toolItem("t1", "edit_file", JSON.stringify({ path: "src/models.py" }), "inProgress"));
	run.handleNotification("item/completed", {
		sessionId: "session-1",
		item: { itemId: "t1", kind: "toolCall", turnId: "turn-1", status: "completed", tool: "edit_file", args: JSON.stringify({ path: "src/models.py" }), visibleOutput: "SECRET FILE CONTENTS SHOULD NOT APPEAR" },
	});

	// The user sees a start and an outcome, both naming the tool and its target — never the raw tool payload.
	expect(activity.some((line) => line.includes("edit_file") && line.includes("src/models.py"))).toBe(true);
	expect(activity.length).toBeGreaterThanOrEqual(2);
	expect(activity.join("\n")).not.toContain("SECRET FILE CONTENTS");
	run.settle();
});

test("change stats surface exact bounded statistics only, never the surrounding output", () => {
	const activity: string[] = [];
	const run = new TurnRun({ host: acceptingHost(), sessionId: "session-1", onActivityDelta: (delta) => activity.push(delta.trim()) });
	run.turnId = "turn-1";

	run.handleNotification("item/started", toolItem("t2", "edit_file", JSON.stringify({ path: "src/msp.ts" }), "inProgress"));
	run.handleNotification("item/completed", {
		sessionId: "session-1",
		item: {
			itemId: "t2",
			kind: "toolCall",
			turnId: "turn-1",
			status: "completed",
			tool: "edit_file",
			args: JSON.stringify({ path: "src/msp.ts" }),
			visibleOutput: "applied cleanly.\n3 insertions(+), 2 deletions(-)\nPRIVATE_BODY_SENTINEL first line\nSECOND_LINE_SENTINEL",
		},
	});

	const body = activity.join("\n");
	expect(body).toContain("3 insertions(+), 2 deletions(-)");
	expect(body).not.toContain("PRIVATE_BODY_SENTINEL");
	expect(body).not.toContain("SECOND_LINE_SENTINEL");
	expect(body).not.toContain("applied cleanly");
	run.settle();
});

test("a statistic-shaped prefix cannot expose arbitrary multiline tool output", () => {
	const activity: string[] = [];
	const run = new TurnRun({ host: acceptingHost(), sessionId: "session-1", onActivityDelta: (delta) => activity.push(delta) });
	run.turnId = "turn-1";
	try {
		run.handleNotification("item/completed", {
			sessionId: "session-1",
			item: {
				itemId: "secret", kind: "toolCall", turnId: "turn-1", status: "completed", tool: "read_file",
				args: JSON.stringify({ path: "private.txt" }),
				visibleOutput: "3 insertions\nPRIVATE_FILE_BODY,\n2 deletions",
			},
		});
		expect(activity.join("")).toContain("read_file");
		expect(activity.join("")).not.toContain("PRIVATE_FILE_BODY");
	} finally {
		run.settle();
	}
});

test("todo tool calls are hidden; the canonical session snapshot drives the plan, including an empty clear", () => {
	const activity: string[] = [];
	const snapshots: MuseTodoEntry[][] = [];
	const run = new TurnRun({
		host: acceptingHost(),
		sessionId: "session-1",
		onActivityDelta: (delta) => activity.push(delta.trim()),
		onTodoSnapshot: (entries) => snapshots.push(entries),
	});
	run.turnId = "turn-1";

	// Proposed args at tool start are not a snapshot: neither an activity line nor a callback.
	run.handleNotification("item/started", toolItem("t3", "write_todos", JSON.stringify({
		items: [{ text: "Stage repo", status: "in_progress" }, { text: "Push", status: "pending" }],
	}), "inProgress"));
	run.handleNotification("item/completed", toolItem("t3", "write_todos", JSON.stringify({ items: [] }), "completed"));
	expect(snapshots).toEqual([]);
	expect(activity).toEqual([]);

	// The canonical session event delivers the whole list, and a later empty one clears it.
	run.handleNotification("session/todoListChanged", {
		sessionId: "session-1",
		revision: 1,
		items: [
			{ text: "Stage repo", status: "inProgress" },
			{ text: "Push", status: "pending" },
		],
		viewCursor: "c1",
	});
	run.handleNotification("session/todoListChanged", { sessionId: "session-1", revision: 2, items: [], viewCursor: "c2" });

	expect(snapshots).toEqual([
		[{ label: "Stage repo", status: "inProgress" }, { label: "Push", status: "pending" }],
		[],
	]);
	run.settle();
});

test("web sources report one label-shaped host per site, whatever punctuation trails the URL", () => {
	const activity: string[] = [];
	const run = new TurnRun({ host: acceptingHost(), sessionId: "session-1", onActivityDelta: (delta) => activity.push(delta.trim()) });
	run.turnId = "turn-1";

	run.handleNotification("item/completed", {
		sessionId: "session-1",
		item: {
			itemId: "t4",
			kind: "toolCall",
			turnId: "turn-1",
			status: "completed",
			tool: "web_search",
			args: JSON.stringify({ query: "oh-my-pi plugin manager" }),
			// Markdown delimiters and duplicate URLs must not produce extra hostnames.
			visibleOutput: "**[omp](https://omp.sh)** and https://omp.sh/docs plus [bun](https://bun.sh), then https://pi.dev.",
		},
	});

	expect(activity).toHaveLength(1);
	const line = activity[0] ?? "";
	expect(line).toContain("omp.sh");
	expect(line).toContain("bun.sh");
	expect(line).toContain("pi.dev");
	expect(line.match(/omp\.sh/g)).toHaveLength(1); // the duplicated, punctuation-trailing spelling is deduplicated
	expect(line).not.toContain(")**");
	run.settle();
});

test("failure results report the failure reason, never the raw output", () => {
	const activity: string[] = [];
	const run = new TurnRun({ host: acceptingHost(), sessionId: "session-1", onActivityDelta: (delta) => activity.push(delta.trim()) });
	run.turnId = "turn-1";

	run.handleNotification("item/started", toolItem("t5", "bash", JSON.stringify({ command: "bun test" }), "inProgress"));
	run.handleNotification("item/completed", {
		sessionId: "session-1",
		item: {
			itemId: "t5",
			kind: "toolCall",
			turnId: "turn-1",
			status: "failed",
			tool: "bash",
			args: JSON.stringify({ command: "bun test" }),
			failureReason: "exited 1",
			visibleOutput: "RAW_STDERR_SENTINEL_WITH_SECRET",
		},
	});

	const body = activity.join("\n");
	expect(body).toContain("exited 1");
	expect(body).toContain("bun test");
	expect(body).not.toContain("RAW_STDERR_SENTINEL_WITH_SECRET");
	run.settle();
});
