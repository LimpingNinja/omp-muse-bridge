import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@oh-my-pi/pi-utils";

import { getBundledAgentPath } from "./runtime.ts";


const AGENT_FILE = "muse-spark.md";

export interface AgentSetupResult {
	path: string;
	status: "installed" | "updated" | "unchanged" | "removed" | "absent";
	method?: "copy";
}

function lstatIfPresent(filePath: string): fs.Stats | null {
	try {
		return fs.lstatSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function isManagedAgent(filePath: string, stat: fs.Stats): boolean {
	try {
		if (stat.isSymbolicLink()) {
			const target = path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
			return target === getBundledAgentPath();
		}
		if (!stat.isFile()) return false;
		const { frontmatter } = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
		const meta = frontmatter as Record<string, unknown>;
		const model = typeof meta.model === "string" ? meta.model : "";
		// Accept the historical `pi-muse-bridge` marker so agent files written before the rename stay managed.
		return (meta["managed-by"] === "omp-muse-bridge" || meta["managed-by"] === "pi-muse-bridge")
			&& meta.name === "muse-spark"
			&& model.startsWith("muse-code/");
	} catch {
		return false;
	}
}

function copyAgent(source: string, destination: string): void {
	fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
	fs.chmodSync(destination, 0o600);
}

export function installMuseAgent(agentDir = path.join(getAgentDir(), "agents")): AgentSetupResult {
	const source = getBundledAgentPath();
	const destination = path.join(agentDir, AGENT_FILE);
	fs.mkdirSync(agentDir, { recursive: true });
	const existing = lstatIfPresent(destination);
	if (existing && !isManagedAgent(destination, existing)) {
		throw new Error(`Refusing to overwrite unrelated agent: ${destination}`);
	}
	if (existing?.isFile() && fs.readFileSync(destination, "utf8") === fs.readFileSync(source, "utf8")) {
		return { path: destination, status: "unchanged", method: "copy" };
	}
	if (existing) fs.rmSync(destination, { force: true });
	copyAgent(source, destination);
	return { path: destination, status: existing ? "updated" : "installed", method: "copy" };
}

export function removeMuseAgent(agentDir = path.join(getAgentDir(), "agents")): AgentSetupResult {
	const destination = path.join(agentDir, AGENT_FILE);
	const existing = lstatIfPresent(destination);
	if (!existing) return { path: destination, status: "absent" };
	if (!isManagedAgent(destination, existing)) {
		throw new Error(`Refusing to remove unrelated agent: ${destination}`);
	}
	fs.rmSync(destination, { force: true });
	return { path: destination, status: "removed" };
}

export function registerMuseSetupCommands(pi: ExtensionAPI): void {
	pi.registerCommand("muse-setup", {
		description: "Install the muse-spark definition for Pi's official subagent tool",
		handler: async (_args, ctx) => {
			try {
				const result = installMuseAgent();
				ctx.ui.notify(
					result.status === "unchanged"
						? `Muse subagent is already installed: ${result.path}`
						: `Muse subagent ${result.status}: ${result.path}`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
			}
		},
	});
	pi.registerCommand("muse-remove", {
		description: "Remove the muse-spark definition managed by omp-muse-bridge",
		handler: async (_args, ctx) => {
			try {
				const result = removeMuseAgent();
				ctx.ui.notify(
					result.status === "absent"
						? `Muse subagent is not installed: ${result.path}`
						: `Muse subagent removed: ${result.path}`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
			}
		},
	});
}
