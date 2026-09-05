import { expect, test } from "bun:test";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { contextCheckpoint, prepareMuseContext } from "../src/context.ts";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "fixture", model: "fixture",
		stopReason: "stop", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

test("compaction decisions retain reserved space when recent history exceeds the seed budget", () => {
	const context: Context = { messages: [
		{ role: "user", content: "OBSOLETE_PRECOMPACTION_CONTEXT", timestamp: 0 },
		{ role: "user", attribution: "agent", content: "Prior model work/tool state available.\n<summary>RETAINED_COMPACTION_DECISION</summary>", timestamp: 0 },
		...Array.from({ length: 50 }, () => assistant("recent context ".repeat(100))),
		{ role: "user", content: "CURRENT_TASK_ONCE", timestamp: 0 },
	] };
	const seed = prepareMuseContext(context, "/workspace").initialPrompt();
	const history = seed.match(/<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/)?.[1] ?? "";
	expect(history).toContain("RETAINED_COMPACTION_DECISION");
	expect(history.length).toBeLessThanOrEqual(40_000);
	expect(seed).not.toContain("OBSOLETE_PRECOMPACTION_CONTEXT");
	expect(seed.match(/CURRENT_TASK_ONCE/g)).toHaveLength(1);
});

test("fresh seeds retain operating instructions but omit nested OMP tool documentation", () => {
	const context: Context = {
		systemPrompt: ["# Role\nKEEP_ROLE\n# Tools\nDROP_TOOL\n## Shell\nDROP_NESTED_TOOL\n# Behavior\nKEEP_BEHAVIOR"],
		messages: [{ role: "user", content: "CURRENT_TASK", timestamp: 0 }],
	};
	const seed = prepareMuseContext(context, "/workspace").initialPrompt();
	expect(seed).toContain("KEEP_ROLE");
	expect(seed).toContain("KEEP_BEHAVIOR");
	expect(seed).not.toContain("DROP_TOOL");
	expect(seed).not.toContain("DROP_NESTED_TOOL");
	expect(seed.endsWith("CURRENT_TASK")).toBe(true);
});

test("checkpoint comparison ignores presentation and opaque reasoning but detects changed history", () => {
	const original = assistant("answer");
	const stored: AssistantMessage = { ...original, timestamp: 123, content: [
		{ type: "text", text: "ans" }, { type: "thinking", thinking: "private reasoning" }, { type: "text", text: "wer" },
	] };
	expect(contextCheckpoint([stored])).toBe(contextCheckpoint([original]));
	expect(contextCheckpoint([assistant("changed answer")])).not.toBe(contextCheckpoint([original]));
	expect(contextCheckpoint([], 0, original)).toBe(contextCheckpoint([stored]));
});

test("new image turns fail explicitly rather than silently losing attachments", () => {
	const context: Context = { messages: [{ role: "user", timestamp: 0, content: [
		{ type: "text", text: "inspect the image" }, { type: "image", data: "AA==", mimeType: "image/png" },
	] }] };
	expect(() => prepareMuseContext(context, "/workspace")).toThrow();
});
