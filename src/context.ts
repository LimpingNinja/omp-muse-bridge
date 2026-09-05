import { createHash, type Hash } from "node:crypto";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { loadMuseSystemPrompt } from "./runtime.ts";

const INITIAL_CONTEXT_CHARS = 40_000;
const TOOL_DETAIL_CHARS = 400;
const COMPACTION_MARKER = "Prior model work/tool state available.";

const BRIDGE_DIRECTIVE = [
	"You are running inside omp-muse-bridge. Your replies stream into OMP; Muse owns tool execution.",
	"OMP shows short tool summaries. State your plan before a tool batch, name its targets, and report the result.",
	"Use your own tools. Prior conversation is context, not a request to repeat completed work.",
].join("\n");

type Message = Context["messages"][number];

export interface MusePromptContext {
	task: string;
	initialPrompt(): string;
	/** OMP history before the current task. */
	checkpoint: string;
	/** Instructions and workspace identity under which the history was seeded. */
	systemPrompt: string;
}

function clip(value: string, limit: number): string {
	if (limit <= 0) return "";
	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function textParts(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

function isCompactionSummary(message: Message): boolean {
	return message.role === "user" && message.attribution === "agent" && textParts(message.content).startsWith(COMPACTION_MARKER);
}

/** Drop tool-documentation sections together with their nested headings. */
function systemPromptWithoutTools(systemPrompt: string[] | undefined): string {
	if (!systemPrompt?.length) return "";
	const joined = systemPrompt.join("\n\n").replace(/<functions>[\s\S]*?<\/functions>/g, "");
	const blocks: string[] = [];
	let current: string[] = [];
	let droppingDepth: number | undefined;
	const flush = () => {
		if (!current.length || droppingDepth !== undefined) return;
		const block = current.join("\n").trimEnd();
		if (!/xd:\/\//i.test(block)) blocks.push(block);
	};
	for (const line of joined.split("\n")) {
		const heading = /^(§|#{1,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const depth = heading[1] === "§" ? 1 : heading[1].length;
			if (droppingDepth !== undefined && depth > droppingDepth) continue;
			flush();
			current = [line];
			droppingDepth = /\btool(s|ing)?\b|xd:\/\/|function calls?/i.test(heading[2]) ? depth : undefined;
		} else if (droppingDepth === undefined) {
			current.push(line);
		}
	}
	flush();
	return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderSeedMessage(message: Message): string {
	if (isCompactionSummary(message)) {
		const summary = textParts(message.content)
			.replace(COMPACTION_MARKER, "")
			.replace(/^\s*MUST build on prior work.*$/m, "")
			.replace(/<\/?summary>/g, "")
			.trim();
		return summary ? `prior_context_summary: ${summary}` : "";
	}
	if (message.role === "assistant") {
		const parts = message.content.flatMap((part) => {
			if (part.type === "text") return [part.text];
			if (part.type === "toolCall") return [`[tool ${part.name} ${clip(JSON.stringify(part.arguments), TOOL_DETAIL_CHARS)}]`];
			return [];
		}).join("\n");
		return parts ? `assistant: ${parts}` : "";
	}
	if (message.role === "toolResult") {
		const body = clip(textParts(message.content), TOOL_DETAIL_CHARS);
		return body ? `tool_result(${message.toolName}${message.isError ? ", error" : ""}): ${body}` : "";
	}
	const body = textParts(message.content);
	return body ? `${message.role}: ${body}` : "";
}

function hashField(hash: Hash, value: string): void {
	hash.update(String(value.length)).update(":").update(value);
}

/** Hash semantic history, excluding opaque reasoning and presentation metadata. */
export function contextCheckpoint(messages: Context["messages"], end = messages.length, response?: AssistantMessage): string {
	const hash = createHash("sha256");
	const append = (message: Message) => {
		hashField(hash, message.role);
		if (message.role === "toolResult") {
			hashField(hash, message.toolName);
			hashField(hash, message.toolCallId);
			hashField(hash, String(message.isError));
		}
		if (typeof message.content === "string") {
			hashField(hash, message.content);
		} else {
			// Text block boundaries may change when OMP stores a streamed response.
			hashField(hash, message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""));
			for (const part of message.content) {
				if (part.type === "toolCall") {
					hashField(hash, part.name);
					hashField(hash, JSON.stringify(part.arguments));
				} else if (part.type === "image") {
					hashField(hash, part.mimeType);
					hashField(hash, part.data);
				}
			}
		}
	};
	for (let index = 0; index < end; index++) append(messages[index]);
	if (response) append(response);
	return hash.digest("hex");
}

/** Seed a new backend session once, reserving history space for the compaction summary. */
export function prepareMuseContext(context: Context, workspace: string): MusePromptContext {
	const messages = context.messages;
	let taskIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "user" && !isCompactionSummary(messages[index])) {
			taskIndex = index;
			break;
		}
	}
	if (taskIndex < 0) throw new Error("Muse provider received no user task");
	const content = messages[taskIndex].content;
	if (Array.isArray(content) && content.some((part) => part.type === "image")) {
		throw new Error("Muse bridge currently accepts text-only turns");
	}
	let task = textParts(content).trim();
	if (!task) throw new Error("Muse provider received an empty user task");
	const additions = messages.slice(taskIndex + 1).map(renderSeedMessage).filter(Boolean);
	if (additions.length) task += `\n\nAdditional context supplied for this task:\n${additions.join("\n")}`;

	const instructions = systemPromptWithoutTools(context.systemPrompt) || loadMuseSystemPrompt();
	let seed: string | undefined;
	const initialPrompt = () => {
		if (seed !== undefined) return seed;
		let historyStart = 0;
		let summary = "";
		for (let index = taskIndex - 1; index >= 0; index--) {
			if (!isCompactionSummary(messages[index])) continue;
			summary = clip(renderSeedMessage(messages[index]), INITIAL_CONTEXT_CHARS);
			historyStart = index + 1;
			break;
		}
		let remaining = INITIAL_CONTEXT_CHARS - summary.length;
		const recent: string[] = [];
		for (let index = taskIndex - 1; index >= historyStart; index--) {
			const entry = renderSeedMessage(messages[index]).trim();
			if (!entry) continue;
			const separator = summary || recent.length ? 1 : 0;
			const admitted = clip(entry, remaining - separator);
			if (!admitted) break;
			recent.push(admitted);
			remaining -= admitted.length + separator;
			if (admitted.length !== entry.length) break;
		}
		recent.reverse();
		if (summary) recent.unshift(summary);
		const sections = [
			BRIDGE_DIRECTIVE,
			`Operating instructions from OMP; tool documentation is omitted.\n<omp_system_prompt>\n${instructions}\n</omp_system_prompt>`,
		];
		if (recent.length) sections.push(`Prior conversation, for context only:\n<conversation_history>\n${recent.join("\n")}\n</conversation_history>`);
		sections.push(`---\n\n${task}`);
		seed = sections.join("\n\n");
		return seed;
	};
	return {
		task,
		initialPrompt,
		checkpoint: contextCheckpoint(messages, taskIndex),
		systemPrompt: createHash("sha256").update(JSON.stringify([workspace, instructions])).digest("hex"),
	};
}
