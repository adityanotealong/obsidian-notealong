import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ApiError, NoteAlongApi } from "../src/api";
import { conflictPath } from "../src/merge";
import { SyncEngine, describeResult, emptyState, type SyncConfig, type SyncState } from "../src/sync";
import { FsVault } from "./fs-vault";
import { MockServer, file } from "./mock-server";

const CONFIG: SyncConfig = {
	root: "NoteAlong",
	feed: { versions: true, transcript: true, flashcards: true },
	deletedNotes: "mark",
};
const NOW = new Date("2026-10-05T12:00:00Z");

let dir: string;
let vault: FsVault;
let server: MockServer;
let state: SyncState;
let saves: number;

function engine(token: string | null = server.token) {
	const api = new NoteAlongApi(server.request, () => "http://api.test", () => token, async () => undefined);
	return new SyncEngine(api, vault);
}

async function sync(config: SyncConfig = CONFIG, eng = engine()) {
	const result = await eng.sync(state, config, {
		save: async (next) => {
			state = next;
			saves += 1;
		},
		now: () => NOW,
	});
	return result;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "na-plugin-"));
	vault = new FsVault(dir);
	server = new MockServer();
	state = emptyState();
	saves = 0;
	server.put("n1", "Cells", [file("n1", "Cells", "NoteAlong/Biology/Cells.md", "Cells are small.", { attachments: ["na-0123456789.png"] })]);
	server.put("n2", "Loose", [
		file("n2", "Loose", "NoteAlong/Loose.md", "Root note."),
		file("n2", "Loose", "NoteAlong/Loose (es).md", "Nota.", { version: "es" }),
	]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("first sync", () => {
	test("writes every file under the root, images into _attachments, and records state", async () => {
		const result = await sync();
		expect(result).toMatchObject({ written: 3, updated: 0, attachments: 1 });
		const files = await vault.snapshot();
		expect(Object.keys(files).sort()).toEqual([
			"NoteAlong/Biology/Cells.md",
			"NoteAlong/Loose (es).md",
			"NoteAlong/Loose.md",
			"NoteAlong/_attachments/na-0123456789.png",
		]);
		const cells = files["NoteAlong/Biology/Cells.md"];
		expect(cells).toContain("notealong_id: n1");
		expect(cells).toMatch(/notealong_synced: 2026-10-05T12:00:00/);
		expect(cells).toMatch(/notealong_hash: \w+/);
		expect(cells).toContain("## My notes");
		expect(state.files).toEqual({
			"n1:": "NoteAlong/Biology/Cells.md",
			"n2:": "NoteAlong/Loose.md",
			"n2:es": "NoteAlong/Loose (es).md",
		});
		expect(state.account).toBe("u1:ws1");
		expect(state.cursor).toBe("c2");
		expect(state.lastError).toBeNull();
		expect(describeResult(result)).toBe("3 new · 1 image");
	});

	test("maps the feed root onto the chosen folder", async () => {
		await sync({ ...CONFIG, root: "Inbox/Lectures/" });
		const files = Object.keys(await vault.snapshot()).sort();
		expect(files).toEqual([
			"Inbox/Lectures/Biology/Cells.md",
			"Inbox/Lectures/Loose (es).md",
			"Inbox/Lectures/Loose.md",
			"Inbox/Lectures/_attachments/na-0123456789.png",
		]);
	});

	test("feed options travel as query params", async () => {
		await sync({ ...CONFIG, feed: { versions: false, transcript: false, flashcards: true } });
		const url = new URL(server.calls.find((c) => c.url.includes("/v1/export/changes"))!.url);
		expect(url.searchParams.get("versions")).toBe("false");
		expect(url.searchParams.get("transcript")).toBe("false");
		expect(url.searchParams.get("flashcards")).toBe("true");
		expect(url.searchParams.get("limit")).toBe("25");
	});
});

describe("re-sync", () => {
	test("nothing changed: no writes, no image refetch", async () => {
		await sync();
		const writes = vault.writes;
		const result = await sync();
		expect(result).toMatchObject({ written: 0, updated: 0 });
		expect(vault.writes).toBe(writes);
		expect(server.attachmentCalls).toBe(1);
	});

	test("an update keeps My notes, the user's properties, added tags and SR comments", async () => {
		server.put("n3", "Cards", [
			file("n3", "Cards", "NoteAlong/Cards.md", "## Flashcards\n\nWhat is ATP?::Energy currency\n\nWhat is DNA?::Genes"),
		]);
		await sync();
		const path = "NoteAlong/Cards.md";
		let text = (await vault.read(path))!;
		text = text
			.replace("tags:\n  - notealong", "tags:\n  - notealong\n  - mine")
			.replace("---\n\n# Cards", "rating: 5\n---\n\n# Cards")
			.replace("What is ATP?::Energy currency", "What is ATP?::Energy currency <!--SR:!2026-10-09,3,250-->")
			.replace(/%% notealong:keep[^\n]*%%\n/, (m) => `${m}My own thought.\n`);
		// Our own frontmatter keys are kept by the regex above; the SR comment
		// is written by the SR plugin, not an edit.
		await vault.write(path, text);

		server.put("n3", "Cards", [
			file("n3", "Cards", "NoteAlong/Cards.md", "## Flashcards\n\nWhat is ATP?::Energy currency of the cell\n\nWhat is DNA?::Genes"),
		]);
		const result = await sync();
		expect(result).toMatchObject({ updated: 1, conflicts: 0 });
		const after = (await vault.read(path))!;
		expect(after).toContain("Energy currency of the cell <!--SR:!2026-10-09,3,250-->");
		expect(after).toContain("My own thought.");
		expect(after).toContain("rating: 5");
		expect(after).toContain("  - mine");
	});

	test("an edited managed part is never clobbered: the update goes to a conflict copy", async () => {
		await sync();
		const path = "NoteAlong/Loose.md";
		const mine = (await vault.read(path))!.replace("Root note.", "Root note, rewritten by me.");
		await vault.write(path, mine);
		server.put("n2", "Loose", [file("n2", "Loose", "NoteAlong/Loose.md", "Root note v2.")]);
		const result = await sync();
		expect(result.conflicts).toBe(1);
		expect(await vault.read(path)).toBe(mine);
		const copy = (await vault.read(conflictPath(path)))!;
		expect(copy).toContain("Root note v2.");
		expect(conflictPath(path)).toBe("NoteAlong/Loose (NoteAlong update).md");
	});
});

describe("renames, moves, deletions", () => {
	test("a NoteAlong rename/move renames the file (links follow) and tidies the emptied folder", async () => {
		await sync();
		server.put("n1", "Cells 2", [file("n1", "Cells 2", "NoteAlong/Science/Cells 2.md", "Cells are small.")]);
		const result = await sync();
		expect(result.moved).toBe(1);
		expect(vault.renames).toEqual([["NoteAlong/Biology/Cells.md", "NoteAlong/Science/Cells 2.md"]]);
		const files = Object.keys(await vault.snapshot());
		expect(files).toContain("NoteAlong/Science/Cells 2.md");
		expect(files.some((f) => f.startsWith("NoteAlong/Biology"))).toBe(false);
		expect(state.files["n1:"]).toBe("NoteAlong/Science/Cells 2.md");
	});

	test("a file the user moved is followed and left where they put it", async () => {
		await sync();
		await vault.rename("NoteAlong/Loose.md", "NoteAlong/Mine/Moved.md");
		server.put("n2", "Loose", [
			file("n2", "Loose", "NoteAlong/Loose.md", "Root note, updated."),
			file("n2", "Loose", "NoteAlong/Loose (es).md", "Nota.", { version: "es" }),
		]);
		await sync();
		expect(await vault.exists("NoteAlong/Loose.md")).toBe(false);
		expect(await vault.read("NoteAlong/Mine/Moved.md")).toContain("Root note, updated.");
		expect(state.files["n2:"]).toBe("NoteAlong/Mine/Moved.md");
	});

	test("a file the user deleted is not recreated, until restored", async () => {
		await sync();
		await vault.trash("NoteAlong/Loose (es).md");
		server.put("n2", "Loose", [
			file("n2", "Loose", "NoteAlong/Loose.md", "Root note."),
			file("n2", "Loose", "NoteAlong/Loose (es).md", "Nota nueva.", { version: "es" }),
		]);
		await sync();
		expect(await vault.exists("NoteAlong/Loose (es).md")).toBe(false);
		expect(state.removedByUser).toEqual(["n2:es"]);
		// "Restore notes deleted from the vault"
		state = { ...state, removedByUser: [], cursor: null };
		await sync();
		expect(await vault.read("NoteAlong/Loose (es).md")).toContain("Nota nueva.");
	});

	test("a note deleted in NoteAlong keeps its file, marked notealong_deleted (once)", async () => {
		await sync();
		server.remove("n2");
		server.remove("n2", "es");
		const result = await sync();
		expect(result.markedDeleted).toBe(2);
		expect(await vault.read("NoteAlong/Loose.md")).toMatch(/^notealong_deleted: 2026-10-05$/m);
		state = { ...state, cursor: null };
		expect((await sync()).markedDeleted).toBe(0);
	});

	test("…or goes to the trash when the user chose that", async () => {
		await sync();
		server.remove("n2");
		const result = await sync({ ...CONFIG, deletedNotes: "trash" });
		expect(result.trashed).toBe(1);
		expect(vault.trashed).toContain("NoteAlong/Loose.md");
		expect(state.files["n2:"]).toBeUndefined();
		expect(state.removedByUser).not.toContain("n2:");
	});

	test("never overwrites someone else's file at our path", async () => {
		await vault.write("NoteAlong/Loose.md", "# My own file\n");
		await sync();
		expect(await vault.read("NoteAlong/Loose.md")).toBe("# My own file\n");
		expect(await vault.read("NoteAlong/Loose (2).md")).toContain("notealong_id: n2");
		expect(state.files["n2:"]).toBe("NoteAlong/Loose (2).md");
	});

	test("a NoteAlong rename never moves a note onto someone else's file", async () => {
		await sync();
		await vault.write("NoteAlong/Biology/Taken.md", "# Mine\n");
		server.put("n1", "Taken", [file("n1", "Taken", "NoteAlong/Biology/Taken.md", "Cells are small.", { attachments: ["na-0123456789.png"] })]);
		await sync();
		expect(await vault.read("NoteAlong/Biology/Taken.md")).toBe("# Mine\n");
		expect(await vault.read("NoteAlong/Biology/Taken (2).md")).toContain("notealong_id: n1");
		expect(await vault.read("NoteAlong/Biology/Cells.md")).toBeNull();
		expect(state.files["n1:"]).toBe("NoteAlong/Biology/Taken (2).md");
	});

	test("adopts its own file found anywhere under the root (e.g. from a zip export)", async () => {
		await sync();
		const elsewhere = emptyState();
		state = elsewhere; // a new install over the same vault
		const result = await sync();
		expect(result.written).toBe(0);
		expect(state.files["n1:"]).toBe("NoteAlong/Biology/Cells.md");
	});
});

describe("feed paging and errors", () => {
	test("pages through hasMore, persisting the cursor after every page", async () => {
		for (let i = 0; i < 60; i++) server.put(`p${i}`, `P${i}`, [file(`p${i}`, `P${i}`, `NoteAlong/Bulk/P${i}.md`, `Body ${i}`)]);
		const result = await sync();
		expect(result.written).toBe(63);
		const pages = server.calls.filter((c) => c.url.includes("/v1/export/changes")).map((c) => new URL(c.url).searchParams.get("cursor"));
		expect(pages).toEqual([null, "c25", "c50"]);
		expect(saves).toBe(4); // three pages + the end
		expect(state.cursor).toBe(`c${server.seq}`);
	});

	test("410 resync_required or 400 invalid_cursor restarts from the beginning", async () => {
		await sync();
		server.failures.push({ path: "/v1/export/changes", status: 410, body: { error: { code: "resync_required", message: "too old" } } });
		await sync();
		const cursors = server.calls.filter((c) => c.url.includes("/v1/export/changes")).map((c) => new URL(c.url).searchParams.get("cursor"));
		expect(cursors.slice(-2)).toEqual(["c2", null]);
		state = { ...state, cursor: "garbage" };
		await sync();
		expect(state.cursor).toBe("c2");
	});

	test("429 is retried after Retry-After", async () => {
		server.failures.push({ path: "/v1/export/changes", status: 429, headers: { "Retry-After": "1" } });
		const result = await sync();
		expect(result.written).toBe(3);
	});

	test("401 stops the sync with an auth error and records it", async () => {
		await expect(sync(CONFIG, engine("na_pat_revokedrevokedrevoked"))).rejects.toMatchObject({ status: 401 });
		await expect(sync(CONFIG, engine(null))).rejects.toBeInstanceOf(ApiError);
	});

	test("another account or folder starts from scratch; option changes re-read everything", async () => {
		await sync();
		state = { ...state, account: "other:ws" };
		await sync();
		expect(state.account).toBe("u1:ws1");
		const before = server.calls.length;
		await sync({ ...CONFIG, feed: { ...CONFIG.feed, transcript: false } });
		const first = server.calls.slice(before).find((c) => c.url.includes("/v1/export/changes"))!;
		expect(new URL(first.url).searchParams.get("cursor")).toBeNull();
		expect(state.options).toBe("v1t0f1");
	});

	test("concurrent sync calls share one pass", async () => {
		const eng = engine();
		const [a, b] = await Promise.all([sync(CONFIG, eng), sync(CONFIG, eng)]);
		expect(a).toBe(b);
		expect(server.calls.filter((c) => c.url.includes("/v1/export/whoami"))).toHaveLength(1);
	});
});

describe("re-sent notes and conflicts", () => {
	const path = "NoteAlong/Loose.md";

	async function editManaged(): Promise<string> {
		const mine = (await vault.read(path))!.replace("Root note.", "Root note, rewritten by me.");
		await vault.write(path, mine);
		return mine;
	}

	test("an unchanged re-send after a managed edit: no copy, no write", async () => {
		await sync();
		const mine = await editManaged();
		const writes = vault.writes;
		// The feed re-sends the same note (the ~5 min overlap).
		server.put("n2", "Loose", [
			file("n2", "Loose", path, "Root note."),
			file("n2", "Loose", "NoteAlong/Loose (es).md", "Nota.", { version: "es" }),
		]);
		const result = await sync();
		expect(result).toMatchObject({ conflicts: 0, updated: 0, written: 0, unchanged: 2 });
		expect(vault.writes).toBe(writes);
		expect(await vault.exists(conflictPath(path))).toBe(false);
		expect(await vault.read(path)).toBe(mine);
		expect(describeResult(result)).toBe("up to date");
	});

	test("regression: edit → unchanged re-send → no copy; then a real change → exactly one copy, written once", async () => {
		await sync();
		const mine = await editManaged();
		server.put("n2", "Loose", [file("n2", "Loose", path, "Root note.")]);
		expect((await sync()).conflicts).toBe(0);
		expect(await vault.exists(conflictPath(path))).toBe(false);

		server.put("n2", "Loose", [file("n2", "Loose", path, "Root note v2.")]);
		const changed = await sync();
		expect(changed.conflicts).toBe(1);
		expect(await vault.read(path)).toBe(mine);
		const copy = (await vault.read(conflictPath(path)))!;
		expect(copy).toContain("Root note v2.");
		const copies = Object.keys(await vault.snapshot()).filter((f) => f.includes("(NoteAlong update)"));
		expect(copies).toEqual([conflictPath(path)]);

		// The same new body re-sent: the identical copy is not rewritten or recounted.
		const writes = vault.writes;
		server.put("n2", "Loose", [file("n2", "Loose", path, "Root note v2.")]);
		const again = await sync();
		expect(again.conflicts).toBe(0);
		expect(vault.writes).toBe(writes);
		expect(await vault.read(conflictPath(path))).toBe(copy);
		expect(await vault.read(path)).toBe(mine);

		// Yet another new body: the copy is refreshed (one write), the file still untouched.
		server.put("n2", "Loose", [file("n2", "Loose", path, "Root note v3.")]);
		const third = await sync();
		expect(third.conflicts).toBe(1);
		expect(vault.written.slice(writes)).toEqual([conflictPath(path)]);
		expect(await vault.read(conflictPath(path))).toContain("Root note v3.");
		expect(await vault.read(path)).toBe(mine);
	});

	test("an unedited file is updated in place on a real change, without a copy", async () => {
		await sync();
		server.put("n2", "Loose", [file("n2", "Loose", path, "Root note v2.")]);
		const writes = vault.writes;
		const result = await sync();
		expect(result).toMatchObject({ updated: 1, conflicts: 0 });
		expect(vault.written.slice(writes)).toEqual([path]);
		expect(await vault.read(path)).toContain("Root note v2.");
		expect(await vault.exists(conflictPath(path))).toBe(false);
	});

	test("a NoteAlong folder move over an edited file moves it, keeps the edit, writes nothing else", async () => {
		await sync();
		await editManaged();
		const writes = vault.writes;
		server.put("n2", "Loose", [file("n2", "Loose", "NoteAlong/Archive/Loose.md", "Root note.")]);
		const result = await sync();
		expect(result).toMatchObject({ moved: 1, conflicts: 0, updated: 0 });
		expect(vault.renames).toEqual([[path, "NoteAlong/Archive/Loose.md"]]);
		expect(vault.writes).toBe(writes);
		expect(await vault.read("NoteAlong/Archive/Loose.md")).toContain("Root note, rewritten by me.");
		expect(state.files["n2:"]).toBe("NoteAlong/Archive/Loose.md");
	});

	test("an owned-property change over an edited file is applied in place; the edit stays", async () => {
		await sync();
		await editManaged();
		server.put("n2", "Loose", [
			{ ...file("n2", "Loose", path, "Root note."), markdown: file("n2", "Loose", path, "Root note.").markdown.replace("title: Loose", "title: Loose\nfolder: Inbox") },
		]);
		const result = await sync();
		expect(result).toMatchObject({ updated: 1, conflicts: 0 });
		const text = (await vault.read(path))!;
		expect(text).toContain("folder: Inbox");
		expect(text).toContain("Root note, rewritten by me.");
		expect(await vault.exists(conflictPath(path))).toBe(false);
	});

	test("files from 0.1.0 (no change) are adopted without a single write", async () => {
		// What 0.1.0 wrote for this render: same merge, recorded hash and all.
		await sync();
		const before = await vault.snapshot();
		state = emptyState(); // a fresh install over the same vault
		const writes = vault.writes;
		for (const id of ["n1", "n2"]) server.put(id, server.notes.get(id)!.title, server.notes.get(id)!.files);
		const result = await sync();
		expect(result).toMatchObject({ written: 0, updated: 0, conflicts: 0 });
		expect(vault.writes).toBe(writes);
		expect(await vault.snapshot()).toEqual(before);
	});

	test("a conflict copy is never taken for the note's own file", async () => {
		await sync();
		await editManaged();
		server.put("n2", "Loose", [file("n2", "Loose", path, "Root note v2.")]);
		await sync();
		// The user files their note elsewhere; a new install scans for it.
		await vault.rename(path, "NoteAlong/Zz/Loose.md");
		state = emptyState();
		const copy = await vault.read(conflictPath(path));
		await sync();
		// The user's file is still the note's file (its new body is offered
		// next to it); the old copy was not adopted, moved or rewritten.
		expect(await vault.read("NoteAlong/Zz/Loose.md")).toContain("Root note, rewritten by me.");
		expect(await vault.read(conflictPath("NoteAlong/Zz/Loose.md"))).toContain("Root note v2.");
		expect(await vault.read(conflictPath(path))).toBe(copy);
		expect(await vault.exists(path)).toBe(false);
	});

	test("attachments already present are never fetched or written again", async () => {
		await sync();
		const binaries = vault.binaryWrites;
		server.put("n1", "Cells", [file("n1", "Cells", "NoteAlong/Biology/Cells.md", "Cells are tiny.", { attachments: ["na-0123456789.png"] })]);
		await sync();
		expect(vault.binaryWrites).toBe(binaries);
		expect(server.attachmentCalls).toBe(1);
	});
});
