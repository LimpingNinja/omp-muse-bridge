/**
 * Shared vocabulary between the exec path (runtime.ts) and the session-host
 * path (msp.ts). This module MUST stay dependency-free (node builtins only) so
 * msp.ts remains loadable in plain `bun test` without the host-only
 * `@oh-my-pi/pi-coding-agent` resolution that runtime.ts requires.
 */

export type MuseThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface MuseUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function museThinkingLevel(level: MuseThinkingLevel | undefined): string | undefined {
	if (level === "off") return "none";
	if (level === "max") return "ultra";
	return level;
}
