/** Cross-process session persistence with atomic publication and explicit corruption errors. */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, withFileLock } from "@oh-my-pi/pi-utils";

/** Persisted Muse-session linkage for one OMP session. */
export interface StoredMuseSession {
	sessionId: string;
	/** True once the bridge has initialized/resumed the Muse session it names. */
	initialized: boolean;
	/** Hash of OMP history through the last committed assistant response. */
	checkpoint?: string;
	/** Hash of the seeded operating instructions and workspace identity. */
	systemPrompt?: string;
	/** Epoch ms of the last write; drives recency pruning. */
	updatedAt: number;
}

/** Keep at most this many mappings, pruning least recently updated entries. */
const MAX_ENTRIES = 200;
const STORE_FILE = "omp-muse-bridge-sessions.json";

function isSessionId(id: unknown): id is string {
	return typeof id === "string" && id.trim().length > 0;
}

function storeError(message: string): Error {
	return new Error(`omp-muse session store: ${message}`);
}

function storePath(): string {
	return path.join(getAgentDir(), STORE_FILE);
}

/** Strictly validate one stored record; legacy string values mean `initialized` with no checkpoint. */
function parseStoredSession(ompSessionId: string, value: unknown, file: string): StoredMuseSession {
	if (typeof value === "string") {
		if (!isSessionId(value)) throw storeError(`${file} maps "${ompSessionId}" to an invalid legacy session id`);
		return { sessionId: value, initialized: true, updatedAt: 0 };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw storeError(`${file} entry "${ompSessionId}" is not a session record`);
	}
	const record = value as Record<string, unknown>;
	if (!isSessionId(record.sessionId)) throw storeError(`${file} entry "${ompSessionId}" has an invalid sessionId`);
	if (typeof record.initialized !== "boolean") {
		throw storeError(`${file} entry "${ompSessionId}" has an invalid initialized flag`);
	}
	if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) {
		throw storeError(`${file} entry "${ompSessionId}" has an invalid updatedAt`);
	}
	if (record.checkpoint !== undefined && typeof record.checkpoint !== "string") {
		throw storeError(`${file} entry "${ompSessionId}" has an invalid checkpoint`);
	}
	if (record.systemPrompt !== undefined && typeof record.systemPrompt !== "string") {
		throw storeError(`${file} entry "${ompSessionId}" has an invalid systemPrompt`);
	}
	return {
		sessionId: record.sessionId,
		initialized: record.initialized,
		checkpoint: record.checkpoint as string | undefined,
		systemPrompt: record.systemPrompt as string | undefined,
		updatedAt: record.updatedAt,
	};
}

/** Read and validate the whole store. Absent file is normal (empty store); any other failure is explicit. */
async function readStoreFile(file: string): Promise<Map<string, StoredMuseSession>> {
	let raw: string;
	try {
		raw = await fsp.readFile(file, "utf8");
	} catch (err) {
		if (isEnoent(err)) return new Map();
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw storeError(`${file} is not valid JSON; refusing to discard it`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw storeError(`${file} does not contain an object; refusing to discard it`);
	}
	const map = new Map<string, StoredMuseSession>();
	for (const [key, value] of Object.entries(parsed)) {
		if (!isSessionId(key)) throw storeError(`${file} contains an invalid session key`);
		map.set(key, parseStoredSession(key, value, file));
	}
	return map;
}

/** Flush a private replacement before atomically publishing it in the store's directory. */
async function replaceStoreFile(file: string, map: Map<string, StoredMuseSession>): Promise<void> {
	// Prune to the most recently updated entries; tie-break on key for a deterministic survivor set.
	const kept = [...map.entries()]
		.sort((a, b) => b[1].updatedAt - a[1].updatedAt || (a[0] < b[0] ? -1 : 1))
		.slice(0, MAX_ENTRIES);
	kept.sort((a, b) => a[0].localeCompare(b[0]));
	const payload = `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`;
	const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	let handle: fsp.FileHandle | undefined;
	try {
		handle = await fsp.open(temp, "wx", 0o600);
		await handle.writeFile(payload, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fsp.rename(temp, file);
		// Best-effort directory flush so the rename itself survives a crash where supported.
		try {
			const dir = await fsp.open(path.dirname(file));
			try {
				await dir.sync();
			} finally {
				await dir.close();
			}
		} catch {
			// Some filesystems cannot fsync directories; the rename is still atomic.
		}
	} catch (err) {
		if (handle) await handle.close().catch(() => {});
		await fsp.unlink(temp).catch(() => {});
		throw err;
	}
}

/** Read committed state without locking; absent entries return undefined and corruption throws. */
export async function readMuseSession(ompSessionId: string): Promise<StoredMuseSession | undefined> {
	if (!isSessionId(ompSessionId)) throw storeError(`invalid OMP session id "${String(ompSessionId)}"`);
	const map = await readStoreFile(storePath());
	return map.get(ompSessionId);
}

/** Serialize updates across processes and retain the 200 most recently updated sessions. */
export async function writeMuseSession(
	ompSessionId: string,
	record: Omit<StoredMuseSession, "updatedAt">,
): Promise<void> {
	if (!isSessionId(ompSessionId)) throw storeError(`invalid OMP session id "${String(ompSessionId)}"`);
	if (!isSessionId(record.sessionId)) throw storeError("invalid Muse session id");
	const file = storePath();
	await fsp.mkdir(path.dirname(file), { recursive: true });
	await withFileLock(file, async () => {
		const map = await readStoreFile(file);
		map.set(ompSessionId, { ...record, updatedAt: Date.now() });
		await replaceStoreFile(file, map);
	});
}

