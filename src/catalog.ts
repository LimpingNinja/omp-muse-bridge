import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { errorMessage } from "./utils.ts";

export interface MuseCatalogModel {
	id: string;
	name: string;
	isDefault: boolean;
	isCurrent: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface MuseCatalog {
	models: MuseCatalogModel[];
	defaultId: string;
}

interface CatalogRow {
	model_id?: string;
	display_label?: string;
	is_default?: boolean;
	is_current?: boolean;
	context_limit?: number;
	output_limit?: number;
	cost?: {
		input?: string | number;
		output?: string | number;
		cached?: string | number;
	};
}

let cache: (MuseCatalog & { signature: string }) | null = null;

function getCatalogDir(): string {
	const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local/share");
	return path.join(dataHome, "muse/model-catalog");
}

function catalogSignature(catalogDir: string, files: string[]): string | null {
	try {
		return files
			.map((file) => {
				const stat = fs.statSync(path.join(catalogDir, file));
				return `${file}:${stat.mtimeMs}:${stat.size}`;
			})
			.join("|");
	} catch {
		return null;
	}
}

function finiteNumber(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getMuseCatalog(): MuseCatalog {
	const catalogDir = getCatalogDir();
	let files: string[];
	try {
		files = fs.readdirSync(catalogDir).filter((file) => file.endsWith(".json")).sort();
	} catch (error) {
		throw new Error(`Muse catalog unavailable at ${catalogDir} — is Muse Code installed? ${errorMessage(error)}`);
	}
	if (files.length === 0) {
		throw new Error(`Muse catalog empty at ${catalogDir} — no model JSON found. Reinstall Muse Code.`);
	}

	const signature = catalogSignature(catalogDir, files);
	if (cache && signature !== null && signature === cache.signature) {
		return { models: cache.models, defaultId: cache.defaultId };
	}

	const modelsById = new Map<string, MuseCatalogModel>();
	let defaultId: string | null = null;
	let hasCurrentDefault = false;
	for (const file of files) {
		const filePath = path.join(catalogDir, file);
		let data: { rows?: CatalogRow[] };
		try {
			data = JSON.parse(fs.readFileSync(filePath, "utf8")) as typeof data;
		} catch (error) {
			throw new Error(`Invalid Muse catalog ${file}: ${errorMessage(error)}`);
		}
		for (const row of data.rows ?? []) {
			if (!row.model_id) continue;
			const model: MuseCatalogModel = {
				id: row.model_id,
				name: row.display_label || row.model_id,
				isDefault: Boolean(row.is_default),
				isCurrent: Boolean(row.is_current),
				contextWindow: finiteNumber(row.context_limit, 1_000_000),
				maxTokens: finiteNumber(row.output_limit, 128_000),
				cost: {
					input: finiteNumber(row.cost?.input, 0),
					output: finiteNumber(row.cost?.output, 0),
					cacheRead: finiteNumber(row.cost?.cached, 0),
					cacheWrite: 0,
				},
			};
			const existing = modelsById.get(model.id);
			if (!existing || model.isCurrent) modelsById.set(model.id, model);
			if (row.is_default && (!hasCurrentDefault || row.is_current)) {
				defaultId = row.model_id;
				hasCurrentDefault = Boolean(row.is_current);
			}
		}
	}

	const models = [...modelsById.values()];
	if (models.length === 0) throw new Error(`Muse catalog at ${catalogDir} contains no models`);
	if (!defaultId || !modelsById.has(defaultId)) {
		throw new Error(`Muse catalog at ${catalogDir} has no is_default model (found ${models.map((m) => m.id).join(", ")})`);
	}
	if (signature !== null) cache = { models, defaultId, signature };
	return { models, defaultId };
}

export function stripProviderPrefix(raw: string): string {
	const trimmed = raw.trim();
	const lower = trimmed.toLowerCase();
	for (const prefix of ["muse-code/", "muse/", "meta/", "muse:"]) {
		if (lower.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
	}
	return trimmed;
}

export function resolveMuseModelId(model?: string): string {
	const catalog = getMuseCatalog();
	const bare = stripProviderPrefix(model ?? "");
	if (!bare || ["muse-spark", "spark"].includes(bare.toLowerCase())) return catalog.defaultId;
	const match = catalog.models.find((candidate) => candidate.id.toLowerCase() === bare.toLowerCase());
	if (!match) {
		throw new Error(
			`Unknown Muse model "${bare}" — available: ${catalog.models.map((candidate) => candidate.id).join(", ")}`,
		);
	}
	return match.id;
}
