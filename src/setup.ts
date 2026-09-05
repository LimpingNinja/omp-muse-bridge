import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, parseFrontmatter, withFileLock } from "@oh-my-pi/pi-utils";

import { getBundledAgentPath } from "./runtime.ts";
import { errorMessage } from "./utils.ts";


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
		const { frontmatter: meta } = parseFrontmatter(fs.readFileSync(filePath, "utf8"), { rawKeys: true });
		const model = typeof meta.model === "string" ? meta.model : "";
		// Definitions installed before the package rename remain managed.
		return (meta["managed-by"] === "omp-muse-bridge" || meta["managed-by"] === "pi-muse-bridge")
			&& meta.name === "muse-spark"
			&& model.startsWith("muse-code/");
	} catch {
		return false;
	}
}

/** Prepare a private replacement before changing the installed definition. */
function installAgentAtomic(source: string, destination: string, replacing: boolean): void {
	const directory = fs.mkdtempSync(path.join(path.dirname(destination), ".muse-agent-"));
	const staged = path.join(directory, AGENT_FILE);
	try {
		fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
		fs.chmodSync(staged, 0o600);
		if (replacing) {
			const current = lstatIfPresent(destination);
			if (!current || !isManagedAgent(destination, current)) {
				throw new Error(`Agent changed during installation; refusing to replace ${destination}`);
			}
			fs.renameSync(staged, destination);
		} else {
			// A concurrent unrelated writer must not be overwritten by a fresh installation.
			fs.linkSync(staged, destination);
		}
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

/** Install or update a managed definition without overwriting an unrelated agent. */
export async function installMuseAgent(agentDir = path.join(getAgentDir(), "agents")): Promise<AgentSetupResult> {
	const source = getBundledAgentPath();
	const destination = path.join(agentDir, AGENT_FILE);
	fs.mkdirSync(agentDir, { recursive: true });
	return withFileLock(destination, async () => {
		const existing = lstatIfPresent(destination);
		if (existing && !isManagedAgent(destination, existing)) {
			throw new Error(`Refusing to overwrite unrelated agent: ${destination}`);
		}
		if (existing?.isFile() && fs.readFileSync(destination, "utf8") === fs.readFileSync(source, "utf8")) {
			return { path: destination, status: "unchanged", method: "copy" };
		}
		installAgentAtomic(source, destination, existing !== null);
		return { path: destination, status: existing ? "updated" : "installed", method: "copy" };
	});
}

/** Remove only a definition owned by this bridge, under the installation lock. */
export async function removeMuseAgent(agentDir = path.join(getAgentDir(), "agents")): Promise<AgentSetupResult> {
	const destination = path.join(agentDir, AGENT_FILE);
	if (!lstatIfPresent(destination)) return { path: destination, status: "absent" };
	return withFileLock(destination, async () => {
		const existing = lstatIfPresent(destination);
		if (!existing) return { path: destination, status: "absent" };
		if (!isManagedAgent(destination, existing)) throw new Error(`Refusing to remove unrelated agent: ${destination}`);
		fs.rmSync(destination, { force: true });
		return { path: destination, status: "removed" };
	});
}

export function registerMuseSetupCommands(pi: ExtensionAPI): void {
	pi.registerCommand("muse-setup", {
		description: "Install the muse-spark definition for OMP's task tool",
		handler: async (_args, ctx) => {
			try {
				const result = await installMuseAgent();
				ctx.ui.notify(
					result.status === "unchanged"
						? `Muse subagent is already installed: ${result.path}`
						: `Muse subagent ${result.status}: ${result.path}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});
	pi.registerCommand("muse-remove", {
		description: "Remove the muse-spark definition managed by omp-muse-bridge",
		handler: async (_args, ctx) => {
			try {
				const result = await removeMuseAgent();
				ctx.ui.notify(
					result.status === "absent"
						? `Muse subagent is not installed: ${result.path}`
						: `Muse subagent removed: ${result.path}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});
}
