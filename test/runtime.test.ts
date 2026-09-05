import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isolated, temporary, testCatalog } from "./helpers.ts";

const streamFixture = `
import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as cp from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
let frames = [];
spyOn(cp, "spawn").mockImplementation(() => {
	const child = new EventEmitter();
	child.stdout = new PassThrough(); child.stderr = new PassThrough();
	setImmediate(() => {
		for (const frame of frames) {
			const bytes = Buffer.from(JSON.stringify(frame) + "\\n");
			for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
		}
		child.stdout.end(); child.stderr.end(); child.emit("close", 0);
	});
	return child;
});
// Import after installing transport spies to exercise the adapter's module-loading boundary.
const { runMuse } = await import("./src/runtime.ts");
const request = {cwd: process.env.TEST_DIR, model: "muse-test", prompt: "test"};
`;

test("exec preserves text when UTF-8 characters cross chunk boundaries", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const result = await isolated(streamFixture + `
		const expected = "café 日本語 🚀";
		frames = [
			{payload_type: "run.output.delta", payload: {text: expected}},
			{payload_type: "run.terminal.completed", payload: {text: expected}},
		];
		let streamed = "";
		const result = await runMuse({...request, onTextDelta: value => streamed += value});
		assert.equal(streamed, expected);
		assert.equal(result.output, expected);
	`, { TEST_DIR: directory, XDG_DATA_HOME: data });
	expect(result.exitCode, result.stderr).toBe(0);
}));

test("exec honors canonical totals and resets counters when zero is reported", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const result = await isolated(streamFixture + `
		const usage = {input_tokens: 100, prompt_tokens: 100, cache_read_tokens: 80, output_tokens: 10, total_tokens: 110, context_tokens: 240};
		frames = [{payload_type: "run.terminal.completed", payload: {text: "done", usage}}];
		const canonical = await runMuse(request);
		assert.equal(canonical.usage.input, 20);
		assert.equal(canonical.usage.totalTokens, 110);
		assert.equal(canonical.usage.contextTokens, 240);
		frames = [
			{payload_type: "run.usage", payload: {usage}},
			{payload_type: "run.terminal.completed", payload: {text: "done", usage: {input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0}}},
		];
		const cleared = await runMuse(request);
		assert.equal(cleared.usage.input, 0);
		assert.equal(cleared.usage.output, 0);
		assert.equal(cleared.usage.cacheRead, 0);
		assert.equal(cleared.usage.totalTokens, 0);
		assert.equal(cleared.usage.contextTokens, 240);
	`, { TEST_DIR: directory, XDG_DATA_HOME: data });
	expect(result.exitCode, result.stderr).toBe(0);
}));

test.skipIf(process.platform === "win32")("abort terminates a TERM-ignoring descendant after its leader exits", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const fixture = path.join(directory, "fake-muse");
	await fs.writeFile(fixture, `#!${process.execPath}
const fs = require("node:fs");
const {spawn} = require("node:child_process");
fs.writeFileSync(process.env.LEADER_PID, String(process.pid));
const member = spawn(process.execPath, ["--eval", \`
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(process.env.MEMBER_PID, String(process.pid));
setTimeout(() => require("node:fs").writeFileSync(process.env.SURVIVAL_MARKER, "tool kept running"), 7000);
setTimeout(() => process.exit(0), 12000);
\`], {stdio: "ignore"});
process.on("SIGTERM", () => process.exit(0));
const ready = setInterval(() => {
	if (!fs.existsSync(process.env.MEMBER_PID)) return;
	clearInterval(ready);
	process.stdout.write(JSON.stringify({payload_type: "run.output.delta", payload: {text: "ready"}}) + "\\n");
}, 10);
setTimeout(() => process.exit(0), 12000);
`, { mode: 0o700 });
	const result = await isolated(`
		import assert from "node:assert/strict";
		import * as fs from "node:fs";
		import { runMuse } from "./src/runtime.ts";
		const controller = new AbortController();
		let cancelledAt = 0;
		try {
			await assert.rejects(runMuse({cwd: process.env.TEST_DIR, model: "muse-test", prompt: "test", signal: controller.signal, onTextDelta: () => {
				cancelledAt = Date.now();
				controller.abort();
			}}));
			// PID disappearance includes OS reaping races; observe whether the tool can still perform work.
			await Bun.sleep(Math.max(0, cancelledAt + 8000 - Date.now()));
			assert.equal(fs.existsSync(process.env.SURVIVAL_MARKER), false, "cancelled Muse tool continued executing");
		} finally {
			if (fs.existsSync(process.env.LEADER_PID)) {
				const leader = Number(fs.readFileSync(process.env.LEADER_PID, "utf8"));
				try { process.kill(-leader, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
			}
		}
	`, {
		TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: fixture,
		LEADER_PID: path.join(directory, "leader.pid"), MEMBER_PID: path.join(directory, "member.pid"),
		SURVIVAL_MARKER: path.join(directory, "survived"),
	});
	expect(result.exitCode, result.stderr).toBe(0);
}), 15_000);

test("a failed prompt write removes its allocated temporary directory", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const result = await isolated(`
		import { spyOn } from "bun:test";
		import assert from "node:assert/strict";
		import * as fs from "node:fs";
		const mkdir = fs.promises.mkdtemp.bind(fs.promises);
		const write = fs.promises.writeFile.bind(fs.promises);
		let allocated;
		spyOn(fs.promises, "mkdtemp").mockImplementation(async (...args) => allocated = await mkdir(...args));
		spyOn(fs.promises, "writeFile").mockImplementation(async (...args) => {
			if (String(args[0]).endsWith("prompt.md")) throw new Error("injected prompt write failure");
			return write(...args);
		});
		// Import after installing filesystem fault injection for this isolated loading boundary.
		const { runMuse } = await import("./src/runtime.ts");
		await assert.rejects(runMuse({cwd: process.env.TEST_DIR, model: "muse-test", prompt: "private prompt"}));
		assert.ok(allocated);
		assert.equal(fs.existsSync(allocated), false);
	`, { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: "/nonexistent-audit-muse" });
	expect(result.exitCode, result.stderr).toBe(0);
}));
