/**
 * The sync core: change feed → vault. Framework-free (VaultIO + NoteAlongApi
 * are injected) so it runs the same under Obsidian and in tests.
 *
 * Rules — the SAME as NoteAlong's web "Sync to vault folder" (the per-file
 * merge in merge.ts is shared with it), so both write identical vaults:
 * - identity is `notealong_id` (+ version language), never the file name;
 * - a NoteAlong rename/move moves the file (here with FileManager.renameFile,
 *   so links to it follow); a file the USER moved is left where they put it
 *   (found by scanning the root folder for its id);
 * - a file the user deleted is not recreated (until "Restore deleted
 *   notes");
 * - a note deleted in NoteAlong keeps its file, marked `notealong_deleted`
 *   (or goes to the trash when the user chose that);
 * - the managed part is never clobbered after a user edit: a NEW body from
 *   NoteAlong goes to "<name> (NoteAlong update).md" (rewritten only when
 *   it says something new); a re-sent body NoteAlong already wrote leaves
 *   the file alone;
 * - a file whose text would not change (bookkeeping keys aside) is never
 *   rewritten, so vault sync services see no churn; a rename without new
 *   content is only a rename;
 * - conflict copies are never taken for the note's own file;
 * - a note is never moved onto a path that holds somebody else's file (it
 *   gets "<name> (2).md"; the web has the same rule).
 */

import { ApiError, NoteAlongApi, isAuthError, isCursorError, type FeedOptions } from "./api";
import type { VaultIO } from "./io";
import {
	conflictPath,
	fileKey,
	identityOf,
	isConflictCopy,
	markDeleted,
	mergeNote,
	sameContent,
} from "./merge";
import { ATTACHMENTS_DIR, attachmentPath, isInside, normalizeRoot, parentOf, vaultPath } from "./paths";

export interface SyncResult {
	written: number;
	updated: number;
	unchanged: number;
	moved: number;
	conflicts: number;
	markedDeleted: number;
	trashed: number;
	attachments: number;
}

export interface SyncState {
	/** `userId:workspaceId` the state belongs to. */
	account: string | null;
	/** Root folder the paths below are in. */
	root: string | null;
	/** Feed options the cursor was built with ("v1t1f1"). */
	options: string | null;
	cursor: string | null;
	/** fileKey → vault path we last wrote. */
	files: Record<string, string>;
	/** fileKey → managed hash as last written. */
	hashes: Record<string, string>;
	/** fileKeys the user deleted from the vault: never recreated. */
	removedByUser: string[];
	lastSyncAt: string | null;
	lastResult: SyncResult | null;
	lastError: string | null;
}

export function emptyState(): SyncState {
	return {
		account: null,
		root: null,
		options: null,
		cursor: null,
		files: {},
		hashes: {},
		removedByUser: [],
		lastSyncAt: null,
		lastResult: null,
		lastError: null,
	};
}

export function emptyResult(): SyncResult {
	return { written: 0, updated: 0, unchanged: 0, moved: 0, conflicts: 0, markedDeleted: 0, trashed: 0, attachments: 0 };
}

export interface SyncConfig {
	root: string;
	feed: FeedOptions;
	deletedNotes: "mark" | "trash";
}

export function optionsKey(feed: FeedOptions): string {
	return `v${feed.versions ? 1 : 0}t${feed.transcript ? 1 : 0}f${feed.flashcards ? 1 : 0}`;
}

async function freePath(path: string, taken: (p: string) => Promise<boolean>): Promise<string> {
	const stem = path.replace(/\.md$/i, "");
	for (let n = 2; n < 100; n++) {
		const candidate = `${stem} (${n}).md`;
		if (!(await taken(candidate))) return candidate;
	}
	return `${stem} (${Date.now()}).md`;
}

export interface SyncHooks {
	/** Persist state (called after every page and at the end). */
	save(state: SyncState): Promise<void>;
	progress?(notes: number): void;
	now?(): Date;
}

export class SyncEngine {
	private running: Promise<SyncResult> | null = null;

	constructor(
		private readonly api: NoteAlongApi,
		private readonly io: VaultIO,
	) {}

	get busy(): boolean {
		return this.running !== null;
	}

	/** One pass; concurrent callers share the running pass. */
	sync(state: SyncState, config: SyncConfig, hooks: SyncHooks): Promise<SyncResult> {
		this.running ??= this.run(state, config, hooks).finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async run(initial: SyncState, config: SyncConfig, hooks: SyncHooks): Promise<SyncResult> {
		const io = this.io;
		const root = normalizeRoot(config.root);
		const who = await this.api.whoami();
		const account = `${who.user?.id ?? "?"}:${who.workspace?.id ?? "?"}`;
		const options = optionsKey(config.feed);

		let state: SyncState = { ...initial, files: { ...initial.files }, hashes: { ...initial.hashes } };
		if (state.account !== account || state.root !== root) {
			// Another account or another folder: what we knew doesn't apply.
			state = { ...emptyState(), account, root, options };
		} else if (state.options !== options) {
			// Different content per file now: a full pass (files are kept).
			state = { ...state, options, cursor: null };
		}
		const removed = new Set(state.removedByUser);
		const result = emptyResult();
		const now = hooks.now?.() ?? new Date();

		let scan: Map<string, string> | null = null;
		const locate = async (key: string): Promise<string | null> => {
			if (!scan) {
				scan = new Map();
				for (const path of await io.listMarkdown(root, [ATTACHMENTS_DIR])) {
					if (isConflictCopy(path)) continue;
					const text = await io.read(path);
					const id = text === null ? null : identityOf(text.slice(0, 4096));
					if (id && !scan.has(id)) scan.set(id, path);
				}
			}
			return scan.get(key) ?? null;
		};
		const forget = (key: string) => {
			delete state.files[key];
			delete state.hashes[key];
		};
		const tidy = async (from: string) => {
			// A move can leave folders empty: remove ours, never the root.
			let dir = parentOf(from);
			while (dir && dir !== root && isInside(dir, root)) {
				await io.removeEmptyFolder(dir);
				dir = parentOf(dir);
			}
		};
		const attachmentsSeen = new Set<string>();
		let cursor = state.cursor;
		let processed = 0;

		try {
			for (let page = 0; page < 2000; page++) {
				let feed;
				try {
					feed = await this.api.changes(cursor, config.feed);
				} catch (error) {
					if (cursor && isCursorError(error)) {
						cursor = null;
						continue;
					}
					throw error;
				}

				for (const note of feed.notes) {
					for (const file of note.files) {
						const key = fileKey(note.id, file.version ? file.language : null);
						if (removed.has(key)) continue;
						const wanted = vaultPath(file.path, root);
						if (!wanted) continue;

						const known = state.files[key] ?? null;
						let existingPath: string | null = null;
						let keepUserLocation = false;
						if (known) {
							if (await io.exists(known)) {
								existingPath = known;
							} else {
								const moved = await locate(key);
								if (moved) {
									existingPath = moved;
									keepUserLocation = true;
								} else {
									// We wrote it before and it's gone: the user deleted it.
									removed.add(key);
									forget(key);
									continue;
								}
							}
						} else {
							existingPath = await locate(key);
						}

						let target = keepUserLocation && existingPath ? existingPath : wanted;
						if (target !== existingPath && (await io.exists(target))) {
							// Someone else's file sits at our path: never overwrite it.
							const occupant = await io.read(target);
							if (!occupant || identityOf(occupant) !== key) {
								target = await freePath(target, (p) => io.exists(p));
							} else if (!existingPath) {
								existingPath = target;
							} else {
								// A second copy of this note: leave both where they are.
								target = existingPath;
							}
						}

						const existing = existingPath ? await io.read(existingPath) : null;
						const merged = mergeNote(file.markdown, existing, { syncedAt: now });

						if (merged.conflict && existingPath) {
							// A new body from NoteAlong over a user edit: offer it next to
							// their file (once: an identical copy is left alone).
							const copyPath = conflictPath(existingPath);
							const copy = await io.read(copyPath);
							if (copy !== null && sameContent(copy, merged.text)) {
								result.unchanged += 1;
							} else {
								await io.write(copyPath, merged.text);
								result.conflicts += 1;
							}
						} else {
							const moving = existingPath !== null && existingPath !== target;
							if (existingPath && moving) {
								await io.rename(existingPath, target);
								await tidy(existingPath);
								result.moved += 1;
							}
							// Identical apart from our own bookkeeping keys: leave the file
							// (and its modified time) alone.
							const same = existing !== null && (merged.unchanged || sameContent(existing, merged.text));
							if (!same) {
								await io.write(target, merged.text);
								if (existing === null) result.written += 1;
								else result.updated += 1;
							} else if (!moving) {
								result.unchanged += 1;
							}
							state.files[key] = target;
							state.hashes[key] = merged.hash;
						}

						for (const attachment of file.attachments) {
							const path = attachmentPath(root, attachment.name);
							if (!path || attachmentsSeen.has(path)) continue;
							attachmentsSeen.add(path);
							if (await io.exists(path)) continue;
							try {
								await io.writeBinary(path, await this.api.attachment(attachment.url));
								result.attachments += 1;
							} catch (error) {
								if (isAuthError(error)) throw error;
								// An image that vanished server-side: the note still syncs.
							}
						}
					}
					processed += 1;
					hooks.progress?.(processed);
				}

				for (const tomb of feed.deleted) {
					const key = fileKey(tomb.id, tomb.language);
					const path = state.files[key];
					if (!path) continue;
					const text = await io.read(path);
					if (text === null) continue;
					if (config.deletedNotes === "trash") {
						await io.trash(path);
						forget(key);
						result.trashed += 1;
						continue;
					}
					if (/^notealong_deleted:/m.test(text.slice(0, 4096))) continue;
					await io.write(path, markDeleted(text, new Date(tomb.deletedAt)));
					result.markedDeleted += 1;
				}

				cursor = feed.cursor;
				state = { ...state, cursor, removedByUser: [...removed] };
				await hooks.save(state);
				if (!feed.hasMore) break;
			}

			// Files we wrote that are gone from where we put them: moved by the
			// user (follow them) or deleted (leave them out from now on).
			for (const [key, known] of Object.entries(state.files)) {
				if (await io.exists(known)) continue;
				const moved = await locate(key);
				if (moved) {
					state.files[key] = moved;
				} else {
					removed.add(key);
					forget(key);
				}
			}

			state = {
				...state,
				removedByUser: [...removed],
				lastSyncAt: new Date().toISOString(),
				lastResult: result,
				lastError: null,
			};
			await hooks.save(state);
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : "Sync failed.";
			state = { ...state, lastError: message };
			await hooks.save(state).catch(() => undefined);
			throw error instanceof ApiError ? error : new Error(message);
		}
	}
}

/** "3 new · 2 updated · 1 conflict" (only the parts that happened). */
export function describeResult(result: SyncResult): string {
	const parts: string[] = [];
	const add = (count: number, one: string, many = `${one}s`) => {
		if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`);
	};
	add(result.written, "new", "new");
	add(result.updated, "updated", "updated");
	add(result.moved, "moved", "moved");
	add(result.conflicts, "conflict");
	add(result.markedDeleted + result.trashed, "deleted", "deleted");
	add(result.attachments, "image");
	return parts.length ? parts.join(" · ") : "up to date";
}
