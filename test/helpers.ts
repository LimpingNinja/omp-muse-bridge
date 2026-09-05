import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const projectRoot = path.resolve(import.meta.dir, "..");

/** Keep environment changes and module spies outside the test runner's shared process. */
export async function isolated(code: string, env: Record<string, string> = {}) {
	const child = Bun.spawn([process.execPath, "--eval", code], {
		cwd: projectRoot,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 20_000,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
	]);
	return { stdout, stderr, exitCode };
}

export async function temporary<T>(fn: (directory: string) => Promise<T>): Promise<T> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-muse-test-"));
	try {
		return await fn(directory);
	} finally {
		await fs.chmod(directory, 0o700);
		await fs.rm(directory, { recursive: true, force: true });
	}
}

/** Provide deterministic model resolution without reading a developer's Muse catalog. */
export async function testCatalog(directory: string): Promise<string> {
	const data = path.join(directory, "data");
	const catalog = path.join(data, "muse", "model-catalog");
	await fs.mkdir(catalog, { recursive: true });
	await fs.writeFile(path.join(catalog, "test.json"), JSON.stringify({ rows: [{
		model_id: "muse-test", display_label: "Muse test", is_default: true, is_current: true,
		context_limit: 100000, output_limit: 10000,
	}] }));
	return data;
}

/** Real stdio framing with scenario-specific host responses, isolated from installed Muse. */
export async function fakeMuse(directory: string, handler: string): Promise<string> {
	const executable = path.join(directory, "fake-muse");
	await fs.writeFile(executable, `#!${process.execPath}
import * as fs from "node:fs";
import {createInterface} from "node:readline";
const send = value => process.stdout.write(JSON.stringify({jsonrpc: "2.0", ...value}) + "\\n");
const reply = (request, result = {}) => send({id: request.id, result});
const notify = (method, params) => send({method, params});
${handler}
const input = createInterface({input: process.stdin});
input.on("line", line => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	if (onRequest(request)) return;
	const {method, params = {}} = request;
	if (method === "session/start" || method === "session/resume") reply(request, {viewCursor: "live"});
	else if (method === "turn/start") {
		reply(request, {turnId: params.commandId});
		notify("item/completed", {sessionId: params.sessionId, item: {itemId: params.commandId, turnId: params.commandId, kind: "agentMessage", status: "completed", text: "OK"}});
		notify("turn/completed", {sessionId: params.sessionId, turnId: params.commandId, terminal: "completed"});
	} else reply(request);
});
input.on("close", () => process.exit(0));
setTimeout(() => process.exit(2), 15000).unref();
`, { mode: 0o700 });
	return executable;
}
