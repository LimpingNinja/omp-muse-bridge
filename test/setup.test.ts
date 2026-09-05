import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { installMuseAgent, removeMuseAgent } from "../src/setup.ts";
import { getBundledAgentPath } from "../src/runtime.ts";
import { isolated, temporary } from "./helpers.ts";

test("a failed replacement leaves the installed managed definition intact", () => temporary(async (directory) => {
	const result = await isolated(`
		import assert from "node:assert/strict";
		import * as fs from "node:fs";
		import { spyOn } from "bun:test";
		import { installMuseAgent } from "./src/setup.ts";
		const initial = await installMuseAgent(process.env.AGENT_DIR);
		const before = fs.readFileSync(initial.path, "utf8") + "\\nExisting managed customization\\n";
		fs.writeFileSync(initial.path, before);
		const fault = new Error("injected copy failure");
		spyOn(fs, "copyFileSync").mockImplementation(() => { throw fault; });
		await assert.rejects(installMuseAgent(process.env.AGENT_DIR), error => error === fault);
		assert.equal(fs.readFileSync(initial.path, "utf8"), before);
	`, { AGENT_DIR: directory });
	expect(result.exitCode, result.stderr).toBe(0);
}));

test("concurrent installations publish one complete definition", () => temporary(async (directory) => {
	const results = await Promise.all(Array.from({ length: 4 }, () => isolated(`
		import { installMuseAgent } from "./src/setup.ts";
		await installMuseAgent(process.env.AGENT_DIR);
	`, { AGENT_DIR: directory })));
	for (const result of results) expect(result.exitCode, result.stderr).toBe(0);
	const destination = path.join(directory, "muse-spark.md");
	expect(await fs.readFile(destination, "utf8")).toBe(await fs.readFile(getBundledAgentPath(), "utf8"));
	await removeMuseAgent(directory);
	expect(await fs.stat(destination).catch(() => undefined)).toBeUndefined();
}));

test("unrelated definitions survive both setup and removal", () => temporary(async (directory) => {
	const destination = path.join(directory, "muse-spark.md");
	const original = "An agent managed by its user, not the bridge.\n";
	await fs.writeFile(destination, original);
	await expect(installMuseAgent(directory)).rejects.toThrow();
	await expect(removeMuseAgent(directory)).rejects.toThrow();
	expect(await fs.readFile(destination, "utf8")).toBe(original);
}));

test.skipIf(process.platform === "win32")("unrelated symlinks are neither replaced nor followed", () => temporary(async (directory) => {
	const target = path.join(directory, "user-agent.md");
	await fs.writeFile(target, "private user agent\n");
	const destination = path.join(directory, "muse-spark.md");
	await fs.symlink(target, destination);
	await expect(installMuseAgent(directory)).rejects.toThrow();
	await expect(removeMuseAgent(directory)).rejects.toThrow();
	expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true);
	expect(await fs.readFile(target, "utf8")).toBe("private user agent\n");
}));
