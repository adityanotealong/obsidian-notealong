// The merge rules (the same cases NoteAlong's web vault sync is tested with).

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  applySrComments,
  collectSrComments,
  conflictPath,
  fileKey,
  identityOf,
  isConflictCopy,
  managedHash,
  markDeleted,
  mergeNote,
  parseNote,
  sameContent,
} from "../src/merge";

const MARKER =
  "%% notealong:keep — anything below this line is never changed by NoteAlong sync %%";

function render(body: string, extra = ""): string {
  return [
    "---",
    "source_type: youtube",
    "created: 2026-10-02",
    "tags:",
    "  - notealong",
    "  - lecture",
    "notealong_id: n1",
    extra,
    "---",
    "",
    body,
    "",
    "## Flashcards",
    "",
    "What is ATP?::The cell's energy currency.",
    "",
    "Why is backprop efficient?",
    "?",
    "It reuses intermediate gradients.",
    "",
    "## My notes",
    MARKER,
    "",
  ]
    .join("\n")
    .replace("\n\n---", "\n---");
}

const SYNCED = new Date("2026-10-04T10:00:00Z");

test("a new file gets the render plus synced/hash keys", () => {
  const { text, conflict } = mergeNote(render("Body v1"), null, { syncedAt: SYNCED });
  assert.equal(conflict, false);
  assert.match(text, /notealong_synced: 2026-10-04T10:00:00/);
  assert.match(text, /notealong_hash: \w+/);
  assert.match(text, /## My notes\n%% notealong:keep/);
  assert.equal(identityOf(text), fileKey("n1", null));
});

test("re-sync rewrites the managed part and keeps My notes byte for byte", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const mine = `${first}My own thoughts.\n\n- [ ] follow up\n`;
  const { text, conflict } = mergeNote(render("Body v2"), mine, { syncedAt: SYNCED });
  assert.equal(conflict, false);
  assert.match(text, /Body v2/);
  assert.doesNotMatch(text, /Body v1/);
  assert.match(text, /My own thoughts\.\n\n- \[ \] follow up\n$/);
});

test("user frontmatter keys and added tags survive", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const edited = first
    .replace("tags:\n  - notealong\n  - lecture", "tags:\n  - notealong\n  - lecture\n  - exam/final")
    .replace("notealong_id: n1", "notealong_id: n1\nrating: 5\nreviewed: true");
  const { text } = mergeNote(render("Body v2"), edited, { syncedAt: SYNCED });
  assert.match(text, /rating: 5/);
  assert.match(text, /reviewed: true/);
  assert.match(text, /  - exam\/final/);
  assert.equal(text.match(/  - notealong\n/g)?.length, 1);
});

test("an edited managed part is a conflict, never clobbered", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const edited = first.replace("Body v1", "Body v1, fixed by me");
  const { conflict, text } = mergeNote(render("Body v2"), edited, { syncedAt: SYNCED });
  assert.equal(conflict, true);
  assert.match(text, /Body v2/);
  assert.equal(conflictPath("NoteAlong/Bio/Cells.md"), "NoteAlong/Bio/Cells (NoteAlong update).md");
});

test("SR plugin comments are not edits and are carried over by card front", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const reviewed = first
    .replace(
      "What is ATP?::The cell's energy currency.",
      "What is ATP?::The cell's energy currency. <!--SR:!2026-10-20,13,290-->",
    )
    .replace(
      "It reuses intermediate gradients.",
      "It reuses intermediate gradients.\n<!--SR:!2026-10-11,4,250-->",
    );
  const { text, conflict } = mergeNote(render("Body v2"), reviewed, { syncedAt: SYNCED });
  assert.equal(conflict, false);
  assert.match(text, /energy currency\. <!--SR:!2026-10-20,13,290-->/);
  assert.match(text, /intermediate gradients\.\n<!--SR:!2026-10-11,4,250-->/);
});

test("collect/apply SR comments round-trip", () => {
  const body = "a::b <!--SR:!x-->\n\nQ\n?\nA\n<!--SR:!y-->";
  const map = collectSrComments(body);
  assert.equal(map.get("a"), "<!--SR:!x-->");
  assert.equal(map.get("q"), "<!--SR:!y-->");
  assert.equal(applySrComments("a::b\n\nQ\n?\nA", map), body);
});

test("managedHash ignores SR comments and trailing spaces", () => {
  assert.equal(managedHash("x::y <!--SR:!1-->  \n"), managedHash("x::y"));
  assert.notEqual(managedHash("x::y"), managedHash("x::z"));
});

test("deleted notes are marked, not removed", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const marked = markDeleted(first, new Date("2026-10-05T00:00:00Z"));
  assert.match(marked, /notealong_deleted: 2026-10-05/);
  assert.match(marked, /Body v1/);
  assert.equal(parseNote(marked).user?.startsWith("## My notes"), true);
  // Marking twice keeps one key.
  assert.equal(markDeleted(marked, new Date("2026-10-06T00:00:00Z")).match(/notealong_deleted/g)?.length, 1);
});

test("CRLF files from Windows editors parse", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const crlf = `${first}Mine\n`.replace(/\n/g, "\r\n");
  const { text, conflict } = mergeNote(render("Body v2"), crlf, { syncedAt: SYNCED });
  assert.equal(conflict, false);
  assert.match(text, /Mine\n$/);
});

test("versions have their own identity", () => {
  const text = render("x", "notealong_version: es");
  assert.equal(identityOf(text), "n1:es");
});

// ---- "New from NoteAlong" is decided against notealong_hash ---------------

test("an unchanged re-send leaves an edited file untouched: no conflict, no rewrite", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const edited = first.replace("Body v1", "Body v1, fixed by me");
  const later = new Date("2026-10-04T10:05:00Z");
  const result = mergeNote(render("Body v1"), edited, { syncedAt: later });
  assert.equal(result.conflict, false);
  assert.equal(result.unchanged, true);
  assert.equal(result.text, edited);
});

test("an unchanged re-send of an unedited file changes nothing (not even notealong_synced)", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const mine = `${first}My own thoughts.\n`;
  const result = mergeNote(render("Body v1"), mine, { syncedAt: new Date("2026-10-05T00:00:00Z") });
  assert.equal(result.unchanged, true);
  assert.equal(result.conflict, false);
  assert.equal(result.text, mine);
});

test("an unchanged re-send keeps the user's properties, tags and SR comments untouched", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const mine = first
    .replace("  - lecture", "  - lecture\n  - exam/final")
    .replace("notealong_id: n1", "notealong_id: n1\nrating: 5")
    .replace("energy currency.", "energy currency. <!--SR:!2026-10-20,13,290-->");
  const result = mergeNote(render("Body v1"), mine, { syncedAt: SYNCED });
  assert.equal(result.unchanged, true);
  assert.equal(result.text, mine);
});

test("owned properties re-serialized by the Properties editor are not a change", () => {
  const first = mergeNote(render("Body v1", 'folder: "Bio / Cells"'), null, { syncedAt: SYNCED }).text;
  const reserialized = first.replace('folder: "Bio / Cells"', "folder: Bio / Cells");
  const result = mergeNote(render("Body v1", 'folder: "Bio / Cells"'), reserialized, { syncedAt: SYNCED });
  assert.equal(result.unchanged, true);
  assert.equal(result.text, reserialized);
});

test("a new body over an edited managed part is a conflict (once per new body)", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const edited = first.replace("Body v1", "Body v1, fixed by me");
  const result = mergeNote(render("Body v2"), edited, { syncedAt: SYNCED });
  assert.equal(result.conflict, true);
  assert.equal(result.unchanged, false);
  assert.match(result.text, /Body v2/);
  assert.equal(result.hash, managedHash(parseNote(result.text).managed));
  // The same new body re-sent renders the same copy (bookkeeping aside).
  const again = mergeNote(render("Body v2"), edited, { syncedAt: new Date("2026-10-04T10:05:00Z") });
  assert.equal(again.conflict, true);
  assert.equal(sameContent(again.text, result.text), true);
});

test("a new body over an unedited managed part updates in place", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const result = mergeNote(render("Body v2"), `${first}Mine\n`, { syncedAt: SYNCED });
  assert.equal(result.conflict, false);
  assert.equal(result.unchanged, false);
  assert.match(result.text, /Body v2/);
  assert.match(result.text, /Mine\n$/);
});

test("owned property changes from NoteAlong apply over an edited body, which stays as the user left it", () => {
  const first = mergeNote(render("Body v1", "folder: Bio"), null, { syncedAt: SYNCED }).text;
  const recorded = /notealong_hash: (\w+)/.exec(first)?.[1];
  const edited = first
    .replace("Body v1", "Body v1, fixed by me")
    .replace("notealong_id: n1", "notealong_id: n1\nrating: 5");
  const moved = mergeNote(render("Body v1", "folder: Chemistry"), edited, { syncedAt: SYNCED });
  assert.equal(moved.conflict, false);
  assert.equal(moved.unchanged, false);
  assert.match(moved.text, /^folder: Chemistry$/m);
  assert.match(moved.text, /Body v1, fixed by me/);
  assert.match(moved.text, /rating: 5/);
  // Still recorded as NoteAlong's body, so the edit is still known...
  assert.equal(moved.hash, recorded);
  assert.match(moved.text, new RegExp(`notealong_hash: ${recorded}`));
  // ...and the next new body is a conflict, not an overwrite.
  assert.equal(mergeNote(render("Body v2", "folder: Chemistry"), moved.text, { syncedAt: SYNCED }).conflict, true);
});

test("a NoteAlong owned property the user changed is restored on a re-send", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const mine = first.replace("source_type: youtube", "source_type: podcast");
  const result = mergeNote(render("Body v1"), mine, { syncedAt: SYNCED });
  assert.equal(result.unchanged, false);
  assert.match(result.text, /source_type: youtube/);
});

test("a note back after deletion loses its notealong_deleted mark", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const marked = markDeleted(first, new Date("2026-10-05T00:00:00Z"));
  const result = mergeNote(render("Body v1"), marked, { syncedAt: SYNCED });
  assert.equal(result.unchanged, false);
  assert.doesNotMatch(result.text, /notealong_deleted/);
});

test("no notealong_hash on disk (an export): treated as unedited, updated in place", () => {
  const exported = render("Body v1");
  const mine = `${exported}My notes from before.\n`;
  const result = mergeNote(render("Body v2"), mine, { syncedAt: SYNCED });
  assert.equal(result.conflict, false);
  assert.match(result.text, /Body v2/);
  assert.match(result.text, /My notes from before\.\n$/);
  assert.match(result.text, /notealong_hash: \w+/);
  // Same body: nothing worth writing (only bookkeeping keys would differ).
  const same = mergeNote(render("Body v1"), mine, { syncedAt: SYNCED });
  assert.equal(same.conflict, false);
  assert.equal(sameContent(same.text, mine), true);
});

test("an SR comment on its own line mid-body is not an edit", () => {
  const first = mergeNote(render010("Body v1"), null, { syncedAt: SYNCED }).text;
  const reviewed = first.replace(
    "It reuses intermediate gradients.",
    "It reuses intermediate gradients.\n<!--SR:!2026-10-11,4,250-->",
  ).replace("## My notes", "Extra card?\n?\nYes.\n<!--SR:!2026-10-12,4,250-->\n\n## My notes");
  // (the extra card is a user edit; drop it to check only the SR lines)
  const onlySr = reviewed.replace("Extra card?\n?\nYes.\n<!--SR:!2026-10-12,4,250-->\n\n", "");
  const result = mergeNote(render010("Body v2"), onlySr, { syncedAt: SYNCED });
  assert.equal(result.conflict, false);
  assert.match(result.text, /intermediate gradients\.\n<!--SR:!2026-10-11,4,250-->\n\nWhat is ATP/);
  assert.equal(mergeNote(render010("Body v2"), reviewed, { syncedAt: SYNCED }).conflict, true);
});

// Files exactly as NoteAlong 0.1.0 wrote them (same render as above).
const V010_FIRST = [
  "---",
  "source_type: youtube",
  "created: 2026-10-02",
  "tags:",
  "  - notealong",
  "  - lecture",
  "notealong_id: n1",
  "notealong_synced: 2026-10-04T10:00:00",
  "notealong_hash: tktn07xosm",
  "---",
  "",
  "Body v1",
  "",
  "## Flashcards",
  "",
  "Why is backprop efficient?",
  "?",
  "It reuses intermediate gradients.",
  "",
  "What is ATP?::The cell's energy currency.",
  "",
  "## My notes",
  MARKER,
  "",
].join("\n");
// 0.1.0 hashed an own-line SR comment as an empty line.
const V010_WITH_SR = V010_FIRST.replace("tktn07xosm", "1zocapxau5y").replace(
  "It reuses intermediate gradients.",
  "It reuses intermediate gradients.\n<!--SR:!2026-10-11,4,250-->",
);

function render010(body: string): string {
  return render(body)
    .replace(
      "What is ATP?::The cell's energy currency.\n\nWhy is backprop efficient?\n?\nIt reuses intermediate gradients.",
      "Why is backprop efficient?\n?\nIt reuses intermediate gradients.\n\nWhat is ATP?::The cell's energy currency.",
    );
}

test("0.1.0 files: an unchanged re-send leaves them untouched, edited or not", () => {
  assert.equal(mergeNote(render010("Body v1"), V010_FIRST, { syncedAt: SYNCED }).unchanged, true);
  const edited = V010_FIRST.replace("Body v1", "Body v1, fixed by me");
  const result = mergeNote(render010("Body v1"), edited, { syncedAt: SYNCED });
  assert.equal(result.unchanged, true);
  assert.equal(result.text, edited);
  const withSr = mergeNote(render010("Body v1"), V010_WITH_SR, { syncedAt: SYNCED });
  assert.equal(withSr.unchanged, true);
  assert.equal(withSr.text, V010_WITH_SR);
});

test("0.1.0 files: a new body updates unedited files in place and conflicts on edited ones", () => {
  const plain = mergeNote(render010("Body v2"), V010_FIRST, { syncedAt: SYNCED });
  assert.equal(plain.conflict, false);
  assert.match(plain.text, /Body v2/);
  const withSr = mergeNote(render010("Body v2"), V010_WITH_SR, { syncedAt: SYNCED });
  assert.equal(withSr.conflict, false);
  assert.match(withSr.text, /intermediate gradients\.\n<!--SR:!2026-10-11,4,250-->/);
  // A later SR review on its own line (0.1.0 saw an edit here) is not one.
  const reviewed = V010_FIRST.replace(
    "It reuses intermediate gradients.",
    "It reuses intermediate gradients.\n<!--SR:!2026-10-11,4,250-->",
  );
  assert.equal(mergeNote(render010("Body v2"), reviewed, { syncedAt: SYNCED }).conflict, false);
  const edited = V010_FIRST.replace("Body v1", "Body v1, fixed by me");
  assert.equal(mergeNote(render010("Body v2"), edited, { syncedAt: SYNCED }).conflict, true);
});

test("sameContent ignores bookkeeping keys, CRLF and trailing space only", () => {
  const first = mergeNote(render("Body v1"), null, { syncedAt: SYNCED }).text;
  const later = mergeNote(render("Body v1"), null, { syncedAt: new Date("2026-10-06T00:00:00Z") }).text;
  assert.equal(sameContent(first, later), true);
  assert.equal(sameContent(first, `${first.replace(/\n/g, "\r\n")}  \n`), true);
  assert.equal(sameContent(first, first.replace("Body v1", "Body v2")), false);
});

test("conflict copies are recognised by name", () => {
  assert.equal(isConflictCopy(conflictPath("NoteAlong/Bio/Cells.md")), true);
  assert.equal(isConflictCopy("NoteAlong/Bio/Cells.md"), false);
});
