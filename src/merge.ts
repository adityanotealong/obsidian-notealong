/**
 * Edit-safe merge, shared with NoteAlong's web "Sync to vault folder" (the
 * code below is kept identical to the web app's, so both write the same
 * vault). PURE: no DOM, no Obsidian API.
 *
 * A synced file has a MANAGED part (frontmatter keys NoteAlong owns +
 * everything above "## My notes") and a USER part. A re-sync:
 * - rewrites the managed part from the server,
 * - keeps the "My notes" section byte for byte,
 * - keeps frontmatter keys the user added (and tags they added),
 * - keeps Spaced Repetition review comments (`<!--SR:…-->`) on cards whose
 *   front still exists, so the SR plugin's schedule survives,
 * - and never clobbers a managed part the user edited: the file records
 *   `notealong_hash` (hash of the managed body as last written); if the
 *   current body no longer matches, the update goes to a sibling
 *   "<name> (NoteAlong update).md" instead.
 */

export const MY_NOTES_HEADING = "## My notes";
export const KEEP_MARKER_PREFIX = "%% notealong:keep";

/** Frontmatter keys NoteAlong writes (and may therefore overwrite). */
export const OWNED_KEYS = new Set([
  "title",
  "aliases",
  "source",
  "source_type",
  "created",
  "updated",
  "duration_min",
  "language",
  "folder",
  "tags",
  "notealong_id",
  "notealong_version",
  "notealong_url",
  "notealong_synced",
  "notealong_hash",
  "notealong_deleted",
]);

const SR_COMMENT_RE = /<!--SR:[^>]*-->/g;

export interface FrontmatterEntry {
  key: string;
  /** The full source lines of this entry (key line + indented continuation). */
  lines: string[];
}

export interface ParsedNote {
  /** null when the file has no frontmatter block. */
  frontmatter: FrontmatterEntry[] | null;
  /** Body above "## My notes" (managed). */
  managed: string;
  /** "## My notes" heading line + marker + everything after (user), or null. */
  user: string | null;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Top-level YAML entries: a `key:` line at column 0 plus its indented lines. */
export function parseFrontmatterEntries(block: string): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z0-9_][\w.-]*)\s*:/.exec(line);
    if (match) {
      entries.push({ key: match[1], lines: [line] });
    } else if (entries.length > 0 && line.trim() !== "") {
      entries[entries.length - 1].lines.push(line);
    }
  }
  return entries;
}

export function parseNote(text: string): ParsedNote {
  const source = normalizeNewlines(text);
  let frontmatter: FrontmatterEntry[] | null = null;
  let body = source;
  if (source.startsWith("---\n")) {
    const end = source.indexOf("\n---", 4);
    if (end !== -1) {
      const after = source.indexOf("\n", end + 4);
      frontmatter = parseFrontmatterEntries(source.slice(4, end));
      body = after === -1 ? "" : source.slice(after + 1);
    }
  }
  const lines = body.split("\n");
  const userStart = lines.findIndex((line) => line.trim() === MY_NOTES_HEADING);
  if (userStart === -1) {
    return { frontmatter, managed: body, user: null };
  }
  return {
    frontmatter,
    managed: lines.slice(0, userStart).join("\n"),
    user: lines.slice(userStart).join("\n"),
  };
}

/** Value of a simple `key: value` entry (quotes stripped), else null. */
export function frontmatterValue(
  entries: FrontmatterEntry[] | null,
  key: string,
): string | null {
  const entry = entries?.find((candidate) => candidate.key === key);
  if (!entry) return null;
  const raw = entry.lines[0].slice(entry.lines[0].indexOf(":") + 1).trim();
  if (!raw) return null;
  return raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

function listItems(entry: FrontmatterEntry | undefined): string[] {
  if (!entry) return [];
  const inline = entry.lines[0].slice(entry.lines[0].indexOf(":") + 1).trim();
  if (inline.startsWith("[") && inline.endsWith("]")) {
    return inline
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if (inline) return [inline.replace(/^["']|["']$/g, "")];
  return entry.lines
    .slice(1)
    .map((line) => /^\s*-\s*(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .map((item) => item.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** cyrb53: small, fast, stable 53-bit string hash (edit detection only). */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Hash of a managed body as the user sees it: SR comments (written by the
 * SR plugin, not by the user) and trailing whitespace don't count as edits.
 */
export function managedHash(managed: string): string {
  const canonical = normalizeNewlines(managed)
    .replace(/[ \t]*<!--SR:[^>]*-->/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
  return hashText(canonical);
}

/** card front → its SR comment, from a managed body. */
export function collectSrComments(managed: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of normalizeNewlines(managed).split(/\n\s*\n/)) {
    const comments = block.match(SR_COMMENT_RE);
    if (!comments) continue;
    const key = cardKey(block.replace(SR_COMMENT_RE, ""));
    if (key) out.set(key, comments[comments.length - 1]);
  }
  return out;
}

function cardKey(block: string): string | null {
  const first = block.trim().split("\n")[0]?.trim() ?? "";
  if (!first) return null;
  const sep = first.indexOf("::");
  return (sep === -1 ? first : first.slice(0, sep)).trim().toLowerCase() || null;
}

/** Re-attach SR comments to the matching cards of a freshly rendered body. */
export function applySrComments(
  managed: string,
  comments: Map<string, string>,
): string {
  if (comments.size === 0) return managed;
  return managed
    .split(/(\n\s*\n)/)
    .map((block) => {
      if (/^\n\s*\n$/.test(block) || block.includes("<!--SR:")) return block;
      const lines = block.split("\n");
      const isCard =
        lines[0]?.includes("::") || (lines.length >= 3 && lines[1]?.trim() === "?");
      if (!isCard) return block;
      const comment = comments.get(cardKey(block) ?? "");
      if (!comment) return block;
      return lines.length === 1 ? `${block} ${comment}` : `${block}\n${comment}`;
    })
    .join("");
}

function renderFrontmatter(entries: FrontmatterEntry[]): string {
  return ["---", ...entries.flatMap((entry) => entry.lines), "---"].join("\n");
}

function yamlQuote(value: string): string {
  return /^[\w./:@ -]+$/.test(value) && !/^[\s-]|:\s|\s$/.test(value)
    ? value
    : JSON.stringify(value);
}

export interface MergeResult {
  /** Final file text to write at the target path. */
  text: string;
  /**
   * The user edited the managed part since our last write: `text` is the
   * fresh render (+ their My notes) and must go to a sibling conflict file;
   * the existing file stays untouched.
   */
  conflict: boolean;
}

/**
 * Merge a freshly rendered file (`incoming`, from the change feed) with what
 * is on disk (`existing`, or null for a new file).
 */
export function mergeNote(
  incoming: string,
  existing: string | null,
  options: { syncedAt: Date },
): MergeResult {
  const fresh = parseNote(incoming);
  const old = existing === null ? null : parseNote(existing);

  // Managed body: fresh render, SR comments carried over by card front.
  let managed = fresh.managed.replace(/\s+$/, "");
  let conflict = false;
  if (old) {
    const recorded = frontmatterValue(old.frontmatter, "notealong_hash");
    if (recorded && recorded !== managedHash(old.managed)) conflict = true;
    managed = applySrComments(managed, collectSrComments(old.managed));
  }

  // User part: theirs when present, else the fresh "My notes" stub.
  const user =
    (old?.user ?? fresh.user ?? `${MY_NOTES_HEADING}\n`).replace(/\s+$/, "") +
    "\n";

  // Frontmatter: ours, then theirs (keys we don't own), tags unioned.
  const ours = (fresh.frontmatter ?? []).filter(
    (entry) =>
      entry.key !== "notealong_hash" &&
      entry.key !== "notealong_synced" &&
      entry.key !== "notealong_deleted",
  );
  const theirs = (old?.frontmatter ?? []).filter(
    (entry) => !OWNED_KEYS.has(entry.key),
  );
  const freshTags = listItems(ours.find((entry) => entry.key === "tags"));
  const oldTags = listItems(old?.frontmatter?.find((entry) => entry.key === "tags"));
  const extraTags = oldTags.filter(
    (tag) => !freshTags.some((t) => t.toLowerCase() === tag.toLowerCase()),
  );
  const merged = ours.map((entry) =>
    entry.key === "tags" && extraTags.length > 0
      ? {
          key: "tags",
          lines: ["tags:", ...[...freshTags, ...extraTags].map((t) => `  - ${yamlQuote(t)}`)],
        }
      : entry,
  );
  merged.push(
    {
      key: "notealong_synced",
      lines: [`notealong_synced: ${options.syncedAt.toISOString().slice(0, 19)}`],
    },
    { key: "notealong_hash", lines: [`notealong_hash: ${managedHash(managed)}`] },
    ...theirs,
  );

  const text = `${renderFrontmatter(merged)}\n\n${managed.replace(/^\s+/, "")}\n\n${user}`;
  return { text, conflict };
}

/**
 * Mark a file whose note was deleted in NoteAlong: the file stays (it is the
 * user's copy now), with `notealong_deleted: YYYY-MM-DD` in its frontmatter.
 */
export function markDeleted(existing: string, deletedAt: Date): string {
  const parsed = parseNote(existing);
  const entries = (parsed.frontmatter ?? []).filter(
    (entry) => entry.key !== "notealong_deleted",
  );
  entries.push({
    key: "notealong_deleted",
    lines: [`notealong_deleted: ${deletedAt.toISOString().slice(0, 10)}`],
  });
  const body = existing.startsWith("---")
    ? normalizeNewlines(existing).replace(/^---\n[\s\S]*?\n---\n?/, "")
    : normalizeNewlines(existing);
  return `${renderFrontmatter(entries)}\n${body.startsWith("\n") ? "" : "\n"}${body}`;
}

/** "Lecture.md" → "Lecture (NoteAlong update).md". */
export function conflictPath(path: string): string {
  return path.replace(/(\.md)?$/i, " (NoteAlong update).md");
}

/** Identity of a synced file: note id + language version ("" = original). */
export function fileKey(noteId: string, versionLanguage: string | null): string {
  return `${noteId}:${versionLanguage ?? ""}`;
}

/** The identity a file on disk declares in its frontmatter, if any. */
export function identityOf(text: string): string | null {
  const parsed = parseNote(text.slice(0, 4096));
  const id = frontmatterValue(parsed.frontmatter, "notealong_id");
  if (!id) return null;
  return fileKey(id, frontmatterValue(parsed.frontmatter, "notealong_version"));
}
