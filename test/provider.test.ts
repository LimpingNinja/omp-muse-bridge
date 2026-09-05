import { expect, test } from "bun:test";
import { fakeMuse, isolated, temporary, testCatalog } from "./helpers.ts";

const imports = `
import assert from "node:assert/strict";
import {setAgentDir} from "@oh-my-pi/pi-utils";
import {streamMuse, getMuseProviderModels} from "./src/provider.ts";
import {shutdownHost} from "./src/msp.ts";
setAgentDir(process.env.TEST_DIR);
const model = {...getMuseProviderModels().find(model => model.id === "muse-test"), api: "muse-code-cli", provider: "muse-code", baseUrl: "http://localhost"};
const user = text => ({role: "user", content: text, timestamp: 0});
const invoke = (messages, sessionId, state) => streamMuse(model, {systemPrompt: ["# Role\\nSEED_SYSTEM"], messages}, {sessionId, providerSessionState: state}, {workspace: process.env.TEST_DIR}).result();
const answer = message => message.content.filter(part => part.type === "text").map(part => part.text).join("");
`;

test("the provider replaces an unobservable session instead of degrading to exec", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, `
		if (process.argv.includes("exec")) process.exit(9);
		let opened = 0;
		function onRequest(request) {
			if (request.method !== "session/start") return false;
			reply(request, {viewCursor: ++opened === 1 ? "" : "live"}); return true;
		}
	`);
	const result = await isolated(imports + `
		try {
			const result = await invoke([user("task")], "omp-test", new Map());
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(answer(result), "OK");
		} finally { shutdownHost(); }
	`, { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: executable });
	expect(result.exitCode, result.stderr).toBe(0);
}));

test("measured zero context occupancy replaces prior occupancy instead of becoming unknown", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, `
		function onRequest(request) {
			if (request.method === "turn/start") {
				notify("session/contextUsage", {sessionId: request.params.sessionId, usedTokens: 240});
				notify("session/contextUsage", {sessionId: request.params.sessionId, usedTokens: 0});
			}
			return false;
		}
	`);
	const result = await isolated(imports + `
		try {
			const result = await invoke([user("task")], "omp-zero", new Map());
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(result.contextSnapshot?.promptTokens, 0);
		} finally { shutdownHost(); }
	`, { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: executable });
	expect(result.exitCode, result.stderr).toBe(0);
}));

test("forks isolate backend history without invalidating their parent's continuity", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, `
		const counts = new Map();
		function onRequest(request) {
			if (request.method !== "turn/start") return false;
			const params = request.params;
			const count = (counts.get(params.sessionId) ?? 0) + 1;
			counts.set(params.sessionId, count);
			reply(request, {turnId: params.commandId});
			if (count === 1 && !params.input[0].text.includes("SEED_SYSTEM")) {
				notify("turn/completed", {sessionId: params.sessionId, turnId: params.commandId, terminal: "failed", error: {message: "missing fresh context"}});
				return true;
			}
			notify("item/completed", {sessionId: params.sessionId, item: {itemId: params.commandId, turnId: params.commandId, kind: "agentMessage", status: "completed", text: String(count)}});
			notify("turn/completed", {sessionId: params.sessionId, turnId: params.commandId, terminal: "completed"});
			return true;
		}
	`);
	const result = await isolated(imports + `
		const state = new Map();
		const messages = [user("first")];
		try {
			const first = await invoke(messages, "parent", state);
			assert.equal(answer(first), "1", first.errorMessage);
			messages.push(first, user("second"));
			const second = await invoke(messages, "parent", state);
			assert.equal(answer(second), "2", second.errorMessage);
			messages.push(second);
			const fork = await invoke([...messages, user("fork task")], "fork", new Map(state));
			assert.equal(answer(fork), "1", fork.errorMessage);
			messages.push(user("parent continues"));
			const third = await invoke(messages, "parent", state);
			assert.equal(answer(third), "3", third.errorMessage);
			messages.push(third, {...third, provider: "different-provider", content: [{type: "text", text: "external context"}]}, user("return to Muse"));
			const reseeded = await invoke(messages, "parent", state);
			assert.equal(answer(reseeded), "1", reseeded.errorMessage);
		} finally { shutdownHost(); }
	`, { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: executable });
	expect(result.exitCode, result.stderr).toBe(0);
}));

test("a fresh exec fallback receives operating instructions and preceding context", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, `
		if (process.argv.includes("exec")) {
			const prompt = fs.readFileSync(process.argv[process.argv.indexOf("--prompt-file") + 1], "utf8");
			if (!["SEED_SYSTEM", "SEED_HISTORY", "CURRENT_TASK"].every(value => prompt.includes(value))) process.exit(8);
			process.stdout.write(JSON.stringify({payload_type: "run.terminal.completed", payload: {text: "FALLBACK_SEEDED"}}) + "\\n");
			process.exit(0);
		}
		function onRequest() { process.exit(1); }
	`);
	const result = await isolated(imports + `
		try {
			const result = await invoke([user("SEED_HISTORY"), user("CURRENT_TASK")], "omp-fallback", new Map());
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(answer(result), "FALLBACK_SEEDED");
		} finally { shutdownHost(); }
	`, { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: executable });
	expect(result.exitCode, result.stderr).toBe(0);
}));

test("a failed first turn cannot reuse its uncommitted backend", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, `
		let abandoned;
		function onRequest(request) {
			if (request.method !== "turn/start") return false;
			const params = request.params;
			reply(request, {turnId: params.commandId});
			if (!abandoned) {
				abandoned = params.sessionId;
				notify("turn/completed", {sessionId: params.sessionId, turnId: params.commandId, terminal: "failed", error: {message: "first turn failed after admission"}});
			} else {
				const fresh = params.sessionId !== abandoned && params.input[0].text.includes("SEED_SYSTEM");
				notify("item/completed", {sessionId: params.sessionId, item: {itemId: params.commandId, turnId: params.commandId, kind: "agentMessage", status: "completed", text: fresh ? "FRESH_CONTEXT" : "STALE_CONTEXT"}});
				notify("turn/completed", {sessionId: params.sessionId, turnId: params.commandId, terminal: "completed"});
			}
			return true;
		}
	`);
	const result = await isolated(imports + `
		const state = new Map();
		const messages = [user("first task")];
		try {
			const failed = await invoke(messages, "failed-owner", state);
			assert.equal(failed.stopReason, "error");
			messages.push(failed, user("continue from current OMP context"));
			const next = await invoke(messages, "failed-owner", state);
			assert.equal(next.stopReason, "stop", next.errorMessage);
			assert.equal(answer(next), "FRESH_CONTEXT");
		} finally { shutdownHost(); }
	`, { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: executable });
	expect(result.exitCode, result.stderr).toBe(0);
}));
