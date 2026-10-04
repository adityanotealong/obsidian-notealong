/**
 * The "Vault shim" for tests: VaultIO on a real temp folder with Node fs.
 * Behaves like ObsidianVaultIO (rename moves, trash removes, folders made
 * on demand) without Obsidian.
 */
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { VaultIO } from "../src/io";

export class FsVault implements VaultIO {
	readonly trashed: string[] = [];
	readonly renames: [string, string][] = [];
	writes = 0;

	constructor(readonly root: string) {}

	private abs(path: string): string {
		return join(this.root, ...path.split("/"));
	}

	async exists(path: string): Promise<boolean> {
		try {
			return (await stat(this.abs(path))).isFile();
		} catch {
			return false;
		}
	}

	async read(path: string): Promise<string | null> {
		try {
			return await readFile(this.abs(path), "utf8");
		} catch {
			return null;
		}
	}

	async write(path: string, text: string): Promise<void> {
		await mkdir(dirname(this.abs(path)), { recursive: true });
		await writeFile(this.abs(path), text, "utf8");
		this.writes += 1;
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		await mkdir(dirname(this.abs(path)), { recursive: true });
		await writeFile(this.abs(path), Buffer.from(data));
	}

	async rename(from: string, to: string): Promise<void> {
		await mkdir(dirname(this.abs(to)), { recursive: true });
		await rename(this.abs(from), this.abs(to));
		this.renames.push([from, to]);
	}

	async trash(path: string): Promise<void> {
		await rm(this.abs(path));
		this.trashed.push(path);
	}

	async listMarkdown(folder: string, skipDirs: readonly string[]): Promise<string[]> {
		const out: string[] = [];
		const walk = async (dir: string) => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (skipDirs.includes(entry.name) || entry.name.startsWith(".")) continue;
					await walk(full);
				} else if (entry.name.toLowerCase().endsWith(".md")) {
					out.push(relative(this.root, full).split(sep).join("/"));
				}
			}
		};
		await walk(this.abs(folder));
		return out.sort();
	}

	async removeEmptyFolder(folder: string): Promise<void> {
		try {
			if ((await readdir(this.abs(folder))).length === 0) await rmdir(this.abs(folder));
		} catch {
			// gone or not empty
		}
	}

	/** Every file below the root: path → text (images as "<binary N bytes>"). */
	async snapshot(): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		const walk = async (dir: string) => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) await walk(full);
				else {
					const key = relative(this.root, full).split(sep).join("/");
					const bytes = await readFile(full);
					out[key] = key.endsWith(".md") ? bytes.toString("utf8") : `<binary ${bytes.length} bytes>`;
				}
			}
		};
		await walk(this.root);
		return out;
	}
}
