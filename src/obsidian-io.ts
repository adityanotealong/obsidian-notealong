import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { VaultIO } from "./io";
import { parentOf } from "./paths";

/**
 * VaultIO on Obsidian's Vault / FileManager APIs only: no Node `fs`, so the
 * plugin runs on iOS and Android too. Reads use `vault.read` (not the cache)
 * because the merge compares exact bytes.
 */
export class ObsidianVaultIO implements VaultIO {
	constructor(private readonly app: App) {}

	private file(path: string): TFile | null {
		const entry = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return entry instanceof TFile ? entry : null;
	}

	async exists(path: string): Promise<boolean> {
		if (this.file(path)) return true;
		// Written by something else a moment ago and not indexed yet.
		const normalized = normalizePath(path);
		if (!(await this.app.vault.adapter.exists(normalized))) return false;
		const stat = await this.app.vault.adapter.stat(normalized);
		return stat?.type === "file";
	}

	async read(path: string): Promise<string | null> {
		const file = this.file(path);
		if (file) return this.app.vault.read(file);
		const normalized = normalizePath(path);
		if (await this.exists(normalized)) return this.app.vault.adapter.read(normalized);
		return null;
	}

	private async ensureFolder(folder: string): Promise<void> {
		if (!folder) return;
		const segments = normalizePath(folder).split("/");
		let current = "";
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			const entry = this.app.vault.getAbstractFileByPath(current);
			if (entry instanceof TFolder) continue;
			if (entry) throw new Error(`"${current}" is a file, so NoteAlong can't create a folder there.`);
			try {
				await this.app.vault.createFolder(current);
			} catch (error) {
				// Created concurrently (or by vault sync) since we looked.
				if (!(await this.app.vault.adapter.exists(current))) throw error;
			}
		}
	}

	async write(path: string, text: string): Promise<void> {
		const normalized = normalizePath(path);
		const file = this.file(normalized);
		if (file) {
			await this.app.vault.modify(file, text);
			return;
		}
		await this.ensureFolder(parentOf(normalized));
		if (await this.app.vault.adapter.exists(normalized)) {
			await this.app.vault.adapter.write(normalized, text);
			return;
		}
		await this.app.vault.create(normalized, text);
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const normalized = normalizePath(path);
		const file = this.file(normalized);
		if (file) {
			await this.app.vault.modifyBinary(file, data);
			return;
		}
		await this.ensureFolder(parentOf(normalized));
		await this.app.vault.createBinary(normalized, data);
	}

	async rename(from: string, to: string): Promise<void> {
		const file = this.file(from);
		if (!file) throw new Error(`Couldn't find ${from} to move it.`);
		await this.ensureFolder(parentOf(normalizePath(to)));
		// Updates links to the note when "Automatically update internal links" is on.
		await this.app.fileManager.renameFile(file, normalizePath(to));
	}

	async trash(path: string): Promise<void> {
		const file = this.file(path);
		if (file) await this.app.fileManager.trashFile(file);
	}

	async listMarkdown(folder: string, skipDirs: readonly string[]): Promise<string[]> {
		const start = this.app.vault.getAbstractFileByPath(normalizePath(folder));
		if (!(start instanceof TFolder)) return [];
		const out: string[] = [];
		const walk = (dir: TFolder, depth: number) => {
			if (depth > 30) return;
			for (const child of dir.children) {
				if (child instanceof TFolder) {
					if (skipDirs.includes(child.name) || child.name.startsWith(".")) continue;
					walk(child, depth + 1);
				} else if (child instanceof TFile && child.extension.toLowerCase() === "md") {
					out.push(child.path);
				}
			}
		};
		walk(start, 0);
		return out;
	}

	async removeEmptyFolder(folder: string): Promise<void> {
		const entry = this.app.vault.getAbstractFileByPath(normalizePath(folder));
		if (entry instanceof TFolder && entry.children.length === 0) {
			// An empty folder our own move left behind: remove it outright
			// (non-recursive, so it fails rather than lose anything).
			await this.app.vault.adapter.rmdir(entry.path, false);
		}
	}
}
