/**
 * What the sync engine needs from a vault. obsidian-io.ts implements it
 * with the Vault / FileManager APIs only (no Node: works on iOS/Android);
 * the tests implement it on a temp folder. Paths are vault-relative with
 * forward slashes.
 */
export interface VaultIO {
	/** A file (not a folder) exists at `path`. */
	exists(path: string): Promise<boolean>;
	/** Text of a file, or null when there is none. */
	read(path: string): Promise<string | null>;
	/** Create or overwrite a text file (parent folders created). */
	write(path: string, text: string): Promise<void>;
	/** Create a binary file (parent folders created). */
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	/**
	 * Move a file. In Obsidian this is FileManager.renameFile, which also
	 * updates links to it (when the user's setting says so).
	 */
	rename(from: string, to: string): Promise<void>;
	/** Delete a file the way the user's setting says (trash). */
	trash(path: string): Promise<void>;
	/** Every .md file below `folder` (recursive), skipping `skipDirs` names. */
	listMarkdown(folder: string, skipDirs: readonly string[]): Promise<string[]>;
	/** Remove `folder` if it is empty (never anything else). */
	removeEmptyFolder(folder: string): Promise<void>;
}
