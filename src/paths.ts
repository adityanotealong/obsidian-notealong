/**
 * Vault paths. The change feed always says `NoteAlong/<folders>/<name>.md`
 * and links images as `../…/_attachments/<name>`
 * relative to that root, so the plugin only swaps the first segment for the
 * folder the user chose; everything below keeps the server's layout (the
 * same layout the web's vault-folder sync and the .zip export write).
 */

export const FEED_ROOT = "NoteAlong";
export const ATTACHMENTS_DIR = "_attachments";
export const DEFAULT_ROOT = "NoteAlong";

/** "  /My notes/NoteAlong/ " → "My notes/NoteAlong"; empty → the default. */
export function normalizeRoot(input: string | null | undefined): string {
	const cleaned = (input ?? "")
		.replace(/\\/g, "/")
		.split("/")
		.map((segment) => segment.trim())
		.filter((segment) => segment && segment !== "." && segment !== "..")
		.join("/");
	return cleaned || DEFAULT_ROOT;
}

/**
 * A feed path → a vault path under `root`, or null when the server sent
 * something we refuse to write (outside the export root, `..`, empty).
 */
export function vaultPath(feedPath: string, root: string): string | null {
	const segments = feedPath.replace(/\\/g, "/").split("/");
	if (segments[0] !== FEED_ROOT || segments.length < 2) return null;
	const rest = segments.slice(1);
	if (rest.some((segment) => !segment || segment === "." || segment === "..")) return null;
	return [normalizeRoot(root), ...rest].join("/");
}

export function attachmentPath(root: string, name: string): string | null {
	if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) return null;
	return `${normalizeRoot(root)}/${ATTACHMENTS_DIR}/${name}`;
}

export function parentOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

/** "A/B/x.md" is inside "A" (or equal). */
export function isInside(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}/`);
}
