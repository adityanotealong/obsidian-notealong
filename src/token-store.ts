import type { App } from "obsidian";

/**
 * Where the personal access token lives. Obsidian's SecretStorage (the OS
 * keychain, Obsidian 1.11.4+) when it works; plugin data (data.json in the
 * vault's plugin folder, plain text) only as a fallback when SecretStorage
 * is missing or throws (e.g. no keychain on some Linux setups). The token
 * is read-only (scope export:read) and revocable in NoteAlong.
 *
 * Secret ids must be lowercase letters, digits and dashes; one per install
 * (vault) so two vaults can be connected to different accounts.
 */
export interface TokenData {
	installId: string;
	/** Fallback copy, only when SecretStorage is unavailable. */
	tokenFallback: string | null;
}

export class TokenStore {
	constructor(
		private readonly app: App,
		private readonly data: TokenData,
		private readonly persist: () => Promise<void>,
	) {}

	private get secretId(): string {
		return `notealong-token-${this.data.installId}`;
	}

	private get secrets() {
		const storage = (this.app as App & { secretStorage?: App["secretStorage"] }).secretStorage;
		return storage && typeof storage.getSecret === "function" ? storage : null;
	}

	/** "keychain" | "plugin data" — shown in settings. */
	get location(): string {
		return this.data.tokenFallback ? "plugin data" : "keychain";
	}

	get(): string | null {
		if (this.data.tokenFallback) return this.data.tokenFallback;
		try {
			const value = this.secrets?.getSecret(this.secretId) ?? null;
			return value ? value : null;
		} catch {
			return null;
		}
	}

	async set(token: string): Promise<void> {
		const secrets = this.secrets;
		if (secrets) {
			try {
				secrets.setSecret(this.secretId, token);
				if (secrets.getSecret(this.secretId) === token) {
					if (this.data.tokenFallback) {
						this.data.tokenFallback = null;
						await this.persist();
					}
					return;
				}
			} catch {
				// fall through to plugin data
			}
		}
		this.data.tokenFallback = token;
		await this.persist();
	}

	async clear(): Promise<void> {
		try {
			// SecretStorage has no delete: an empty secret means "none".
			this.secrets?.setSecret(this.secretId, "");
		} catch {
			// nothing stored there
		}
		if (this.data.tokenFallback) {
			this.data.tokenFallback = null;
			await this.persist();
		}
	}
}

/** 12 lowercase letters/digits. */
export function makeInstallId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	let out = "";
	for (const byte of bytes) out += alphabet[byte % alphabet.length];
	return out;
}
