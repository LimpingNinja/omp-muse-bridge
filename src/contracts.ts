/** Transport-independent types shared by the Muse host and exec adapters. */

export type MuseThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface MuseUsage {
	/** Uncached prompt tokens, matching OMP's usage convention. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Counted-once prompt and output tokens, including cached prompt tokens. */
	totalTokens: number;
	cost: number;
	/** Latest measured occupancy; absent when the backend has not reported it. */
	contextTokens?: number;
	turns: number;
}

/** Translate OMP thinking levels to Muse's reasoning-effort vocabulary. */
export function museThinkingLevel(level: MuseThinkingLevel | undefined): string | undefined {
	if (level === "off") return "none";
	if (level === "max") return "ultra";
	return level;
}
