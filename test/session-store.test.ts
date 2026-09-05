import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isolated, temporary } from "./helpers.ts";

const setup = `
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { readMuseSession, writeMuseSession } from "./src/session-store.ts";
setAgentDir(process.env.STORE_DIR);
`;
const storeFile = (directory: string) => path.join(directory, "omp-muse-bridge-sessions.json");

test("independent OMP processes retain each other's session mappings", () => temporary(async (directory) => {
	const writers = await Promise.all(Array.from({ length: 8 }, (_, index) => isolated(setup + `
		await writeMuseSession("omp-${index}", { sessionId: "muse-${index}", initialized: true });
	`, { STORE_DIR: directory })));
	for (const writer of writers) expect(writer.exitCode, writer.stderr).toBe(0);
	const restored = await isolated(setup + `
		const ids = await Promise.all(Array.from({ length: 8 }, (_, index) => readMuseSession("omp-" + index)));
		console.log(JSON.stringify(ids.map(record => record?.sessionId)));
	`, { STORE_DIR: directory });
	expect(restored.exitCode, restored.stderr).toBe(0);
	expect(JSON.parse(restored.stdout)).toEqual(Array.from({ length: 8 }, (_, index) => `muse-${index}`));
}));

test("legacy mappings are readable and retain other sessions when upgraded", () => temporary(async (directory) => {
	await fs.writeFile(storeFile(directory), JSON.stringify({ old: "muse-old", retained: "muse-retained" }));
	const result = await isolated(setup + `
		const old = await readMuseSession("old");
		await writeMuseSession("old", { sessionId: "muse-new", initialized: true, checkpoint: "history-hash" });
		console.log(JSON.stringify({ old, current: await readMuseSession("old"), retained: await readMuseSession("retained") }));
	`, { STORE_DIR: directory });
	expect(result.exitCode, result.stderr).toBe(0);
	const data = JSON.parse(result.stdout);
	expect(data.old.sessionId).toBe("muse-old");
	expect(data.old.checkpoint).toBeUndefined();
	expect(data.current.checkpoint).toBe("history-hash");
	expect(data.retained.sessionId).toBe("muse-retained");
}));

test("corrupt persisted state is rejected without overwriting it", () => temporary(async (directory) => {
	const corrupt = "{ interrupted JSON";
	await fs.writeFile(storeFile(directory), corrupt);
	const result = await isolated(setup + `await writeMuseSession("new", { sessionId: "muse-new", initialized: true });`, { STORE_DIR: directory });
	expect(result.exitCode).not.toBe(0);
	expect(await fs.readFile(storeFile(directory), "utf8")).toBe(corrupt);
}));

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("failed atomic replacement preserves the previous private store", () => temporary(async (directory) => {
	const initial = await isolated(setup + `await writeMuseSession("old", { sessionId: "muse-old", initialized: true });`, { STORE_DIR: directory });
	expect(initial.exitCode, initial.stderr).toBe(0);
	const before = await fs.readFile(storeFile(directory), "utf8");
	await fs.chmod(directory, 0o500);
	try {
		const failed = await isolated(setup + `await writeMuseSession("new", { sessionId: "muse-new", initialized: true });`, { STORE_DIR: directory });
		expect(failed.exitCode).not.toBe(0);
		expect(await fs.readFile(storeFile(directory), "utf8")).toBe(before);
		expect((await fs.stat(storeFile(directory))).mode & 0o777).toBe(0o600);
	} finally {
		await fs.chmod(directory, 0o700);
	}
}));

test("recency pruning retains a recently updated old entry", () => temporary(async (directory) => {
	const records = Object.fromEntries(Array.from({ length: 210 }, (_, index) => [
		`omp-${index}`, { sessionId: `muse-${index}`, initialized: true, updatedAt: index + 1 },
	]));
	await fs.writeFile(storeFile(directory), JSON.stringify(records));
	const result = await isolated(setup + `
		await writeMuseSession("omp-0", { sessionId: "muse-refreshed", initialized: true });
		console.log(JSON.stringify({fresh: await readMuseSession("omp-0"), stale: await readMuseSession("omp-10"), boundary: await readMuseSession("omp-11")}));
	`, { STORE_DIR: directory });
	expect(result.exitCode, result.stderr).toBe(0);
	const data = JSON.parse(result.stdout);
	expect(data.fresh.sessionId).toBe("muse-refreshed");
	expect(data.stale).toBeUndefined();
	expect(data.boundary.sessionId).toBe("muse-11");
	expect(Object.keys(JSON.parse(await fs.readFile(storeFile(directory), "utf8")))).toHaveLength(200);
}));

