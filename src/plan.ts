import type { ExtensionAPI, ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import type { MuseTodoEntry } from "./msp.ts";

const PLAN_TYPE = "muse-plan";

function planEntries(value: unknown): MuseTodoEntry[] | undefined {
	if (!value || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries)) return undefined;
	const entries: MuseTodoEntry[] = [];
	for (const entry of value.entries) {
		if (!entry || typeof entry !== "object" || typeof entry.label !== "string" || typeof entry.status !== "string") return undefined;
		entries.push({ label: entry.label, status: entry.status });
	}
	return entries;
}

function renderPlan(entries: readonly MuseTodoEntry[], theme: Theme): string[] {
	if (!entries.length) return [theme.fg("dim", "  Muse plan cleared")];
	const rows = [theme.fg("border", "  ── Muse plan ──")];
	for (const { label, status } of entries) {
		const done = /done|complete/i.test(status);
		const active = /progress|active|doing/i.test(status);
		const cancelled = /cancel|drop/i.test(status);
		// Non-emoji markers retain text presentation across terminal fonts.
		const glyph = active ? "▸" : done ? "✓" : cancelled ? "✗" : "□";
		const colour = active ? "accent" : done ? "success" : cancelled ? "error" : "muted";
		rows.push(`  ${theme.fg(colour, glyph)} ${theme.fg(done || cancelled ? "dim" : "text", label)}`);
	}
	return rows;
}

export interface MusePlanDisplay {
	/** Capture ownership before an asynchronous provider turn begins. */
	forTurn(): ((entries: MuseTodoEntry[]) => void) | undefined;
}

/** Keep live plans session-scoped and store immutable, display-only transcript snapshots. */
export function registerMusePlanDisplay(pi: ExtensionAPI): MusePlanDisplay {
	let current: ExtensionContext | undefined;
	let latest: MuseTodoEntry[] = [];
	let pending: MuseTodoEntry[] | undefined;

	const show = () => {
		const ctx = current;
		if (!ctx?.hasUI) return;
		const owner = ctx.sessionManager.getSessionId();
		if (!latest.length || ctx.models.current()?.provider !== "muse-code") {
			ctx.ui.setWidget(PLAN_TYPE, undefined);
			return;
		}
		ctx.ui.setWidget(PLAN_TYPE, (_tui, theme) => ({
			render: () => current?.sessionManager.getSessionId() === owner && ctx.models.current()?.provider === "muse-code"
				? renderPlan(latest, theme)
				: [],
		}));
	};

	const restore = (ctx: ExtensionContext) => {
		current?.ui.setWidget(PLAN_TYPE, undefined);
		current = ctx;
		pending = undefined;
		latest = [];
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "custom_message" || entry.customType !== PLAN_TYPE) continue;
			const saved = planEntries(entry.details);
			if (saved) {
				latest = saved;
				break;
			}
		}
		show();
	};

	pi.registerMessageRenderer(PLAN_TYPE, (message, _options, theme) => {
		const entries = planEntries(message.details);
		if (!entries) return undefined;
		return { render: () => renderPlan(entries, theme) };
	});
	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== PLAN_TYPE),
	}));
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_switch", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("agent_start", (_event, ctx) => {
		if (current?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) restore(ctx);
		else {
			current = ctx;
			show();
		}
	});
	pi.on("agent_end", (_event, ctx) => {
		if (current?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) return;
		current = ctx;
		const snapshot = pending;
		pending = undefined;
		if (snapshot) {
			pi.sendMessage({ customType: PLAN_TYPE, content: "", display: true, details: { entries: snapshot } }, { triggerTurn: false });
		}
		// The completed snapshot now belongs to its transcript entry, not a global renderer.
		ctx.ui.setWidget(PLAN_TYPE, undefined);
	});
	pi.on("session_shutdown", () => {
		current?.ui.setWidget(PLAN_TYPE, undefined);
		current = undefined;
		latest = [];
		pending = undefined;
	});

	return {
		forTurn() {
			const ctx = current;
			if (!ctx) return undefined;
			const owner = ctx.sessionManager.getSessionId();
			return (entries) => {
				if (current?.sessionManager.getSessionId() !== owner) return;
				latest = entries.map((entry) => ({ ...entry }));
				pending = latest;
				show();
			};
		},
	};
}
