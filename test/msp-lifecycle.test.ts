import { expect, test } from "bun:test";
import { fakeMuse, isolated, temporary, testCatalog } from "./helpers.ts";

const imports = `
import assert from "node:assert/strict";
import { runMuseTurn, shutdownHost, MuseSessionUnusableError, steerActiveMuseRuns } from "./src/msp.ts";
const args = { sessionId: "muse-test-session", resumeExisting: false, prompt: "test", modelId: "muse-test", workspace: process.env.TEST_DIR, sandboxed: true };
`;

test("an unobservable session preserves its recovery error identity", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, `function onRequest(request) {
		if (request.method !== "session/start") return false;
		reply(request, {viewCursor: ""}); return true;
	}`);
	const result = await isolated(imports + `
		try { await assert.rejects(runMuseTurn(args), MuseSessionUnusableError); }
		finally { shutdownHost(); }
	`, { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: executable });
	expect(result.exitCode, result.stderr).toBe(0);
}));

test("the host outcome awaits durable text after a surviving live terminal", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, `
		let turn;
		function onRequest(request) {
			if (request.method === "turn/start") {
				turn = request.params;
				reply(request, {turnId: turn.commandId});
				notify("view/gap", {sessionId: turn.sessionId, after: "live-a", next: "live-b"});
				notify("turn/completed", {sessionId: turn.sessionId, turnId: turn.commandId, terminal: "completed"});
				return true;
			}
			if (request.method !== "view/page") return false;
			reply(request, {events: [{method: "item/completed", params: {sessionId: turn.sessionId, item: {itemId: "recovered", turnId: turn.commandId, kind: "agentMessage", status: "completed", text: "RECOVERED_ANSWER"}}}], nextCursor: null});
			return true;
		}
	`);
	const result = await isolated(imports + `
		try {
			const result = await runMuseTurn(args);
			assert.equal(result.errorMessage, undefined);
			assert.equal(result.output, "RECOVERED_ANSWER");
		} finally { shutdownHost(); }
	`, { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: executable });
	expect(result.exitCode, result.stderr).toBe(0);
}));

test("cancellation reaches a successor admitted after the parent completed", () => temporary(async (directory) => {
	const data = await testCatalog(directory);
	const executable = await fakeMuse(directory, `
		let turn;
		function onRequest(request) {
			if (request.method === "turn/start") {
				turn = request.params;
				reply(request, {turnId: turn.commandId});
				notify("turn/started", {sessionId: turn.sessionId, turnId: turn.commandId});
				return true;
			}
			if (request.method === "turn/steer") {
				reply(request);
				notify("turn/completed", {sessionId: turn.sessionId, turnId: turn.commandId, terminal: "completed"});
				notify("item/started", {sessionId: turn.sessionId, item: {itemId: "boundary", turnId: turn.commandId, kind: "toolCall", status: "inProgress", tool: "parent_completed"}});
				return true;
			}
			if (request.method !== "turn/interrupt") return false;
			reply(request);
			if (request.params.turnId === turn.commandId) notify("turn/started", {sessionId: turn.sessionId, turnId: "successor"});
			else notify("turn/completed", {sessionId: turn.sessionId, turnId: "successor", terminal: "cancelled"});
			return true;
		}
	`);
	const result = await isolated(imports + `
		const controller = new AbortController();
		let steering;
		try {
			const result = await runMuseTurn({...args, signal: controller.signal, onActivityDelta: (delta) => {
				if (delta.includes("parent_completed")) controller.abort();
				else steering ??= steerActiveMuseRuns("redirect").then(accepted => { assert.equal(accepted, true); });
			}});
			await steering;
			assert.equal(result.aborted, true);
			assert.equal(result.backendInterrupted, true);
		} finally { shutdownHost(); }
	`, { TEST_DIR: directory, XDG_DATA_HOME: data, PI_MUSE_BINARY: executable });
	expect(result.exitCode, result.stderr).toBe(0);
}));
