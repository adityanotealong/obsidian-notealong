// The merge rules (the same cases NoteAlong's web vault sync is tested with).

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  applySrComments,
  collectSrComments,
  conflictPath,
  fileKey,
  identityOf,
  managedHash,
  markDeleted,
  mergeNote,
  parseNote,
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
