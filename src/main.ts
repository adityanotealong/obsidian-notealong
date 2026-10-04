import { Notice, Plugin, requestUrl } from "obsidian";
import { NoteAlongApi, isAuthError } from "./api";
import { ObsidianVaultIO } from "./obsidian-io";
import {
	PROTOCOL_ACTION,
	extractPairingCode,
	freshNonce,
	looksLikeToken,
	makeNonce,
	normalizeServerUrl,
	pairingPageUrl,
} from "./pairing";
import { normalizeRoot } from "./paths";
import { DEFAULT_APP_URL, DEFAULT_SERVER_URL, DEFAULT_SETTINGS, NoteAlongSettingTab, type NoteAlongSettings } from "./settings";
import { SyncEngine, describeResult, emptyState, type SyncState } from "./sync";
import { TokenStore, makeInstallId } from "./token-store";

interface PluginData {
	settings: NoteAlongSettings;
	sync: SyncState;
	installId: string;
	tokenFallback: string | null;
	/** Who the token belongs to (from /v1/export/whoami), for display. */
	account: { name: string | null; email: string | null; workspace: string | null } | null;
	/** The nonce of the last "Connect" (the web binds the code to it). */
	pendingPair: { nonce: string; at: number } | null;
}

export default class NoteAlongPlugin extends Plugin {
	data!: PluginData;
	private tokens!: TokenStore;
	private api!: NoteAlongApi;
	private engine!: SyncEngine;
	private statusEl: HTMLElement | null = null;
	private intervalId: number | null = null;
	private authNoticeShown = false;

	async onload(): Promise<void> {
		await this.loadAll();
		this.tokens = new TokenStore(this.app, this.data, () => this.saveAll());
		this.api = new NoteAlongApi(
			(request) => requestUrl(request),
			() => normalizeServerUrl(this.data.settings.serverUrl, DEFAULT_SERVER_URL),
			() => this.tokens.get(),
		);
		this.engine = new SyncEngine(this.api, new ObsidianVaultIO(this.app));

		this.addSettingTab(new NoteAlongSettingTab(this.app, this));
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("notealong-status");
		this.renderStatus();

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.syncNow({ manual: true }),
		});
		this.addCommand({
			id: "restore-deleted",
			name: "Restore notes deleted from the vault",
			callback: () => void this.restoreDeleted(),
		});
		this.addRibbonIcon("refresh-cw", "Sync NoteAlong", () => void this.syncNow({ manual: true }));

		// obsidian://notealong-auth?vault=<this vault>&code=na_pair_… (opened by
		// NoteAlong's web app; Obsidian strips `vault` and routes by it).
		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
			void this.completePairing(params.code ?? "");
		});

		this.app.workspace.onLayoutReady(() => {
			if (this.data.settings.syncOnStartup && this.tokens.get()) {
				window.setTimeout(() => void this.syncNow({ manual: false }), 3000);
			}
			this.schedule();
		});
	}

	onunload(): void {
		this.clearSchedule();
	}

	// ---------------------------------------------------------------- data

	private async loadAll(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		this.data = {
			settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
			sync: { ...emptyState(), ...(raw.sync ?? {}) },
			installId: raw.installId && /^[a-z0-9]{6,32}$/.test(raw.installId) ? raw.installId : makeInstallId(),
			tokenFallback: raw.tokenFallback ?? null,
			account: raw.account ?? null,
			pendingPair: raw.pendingPair ?? null,
		};
		if (!raw.installId) await this.saveAll();
	}

	async saveAll(): Promise<void> {
		await this.saveData(this.data);
	}

	accountLabel(): string | null {
		if (!this.tokens.get()) return null;
		const account = this.data.account;
		const who = account?.email ?? account?.name ?? "your NoteAlong account";
		const workspace = account?.workspace ? ` (${account.workspace})` : "";
		return `${who}${workspace}. Token stored in the ${this.tokens.location}.`;
	}

	// ------------------------------------------------------------- pairing

	/**
	 * "Connect": open NoteAlong's web app, which sends a pairing code back
	 * through a link that names this vault.
	 */
	startPairing(): void {
		const nonce = makeNonce();
		this.data.pendingPair = { nonce, at: Date.now() };
		void this.saveAll();
		const appUrl = normalizeServerUrl(this.data.settings.appUrl, DEFAULT_APP_URL);
		window.open(pairingPageUrl(appUrl, nonce, this.app.vault.getName()));
		new Notice("Approve the connection in NoteAlong. Obsidian will finish on its own.");
	}

	/** From the protocol handler or a pasted code / link. */
	async completePairing(input: string): Promise<boolean> {
		const code = extractPairingCode(input);
		if (!code) {
			new Notice("That isn't a NoteAlong pairing code. Start again from NoteAlong.");
			return false;
		}
		try {
			const result = await this.api.exchangePairing({
				code,
				nonce: freshNonce(this.data.pendingPair),
				name: `Obsidian (${this.app.vault.getName()})`,
			});
			this.data.pendingPair = null;
			await this.tokens.set(result.token);
			await this.afterConnect();
			return true;
		} catch (error) {
			new Notice(`Couldn't connect NoteAlong: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	async useToken(input: string): Promise<boolean> {
		const token = input.trim();
		if (!looksLikeToken(token)) {
			new Notice("That isn't a NoteAlong token (they start with na_pat_).");
			return false;
		}
		await this.tokens.set(token);
		try {
			await this.afterConnect();
			return true;
		} catch (error) {
			await this.tokens.clear();
			new Notice(
				isAuthError(error)
					? "NoteAlong didn't accept that token."
					: `Couldn't reach NoteAlong: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private async afterConnect(): Promise<void> {
		const who = await this.api.whoami();
		this.data.account = {
			name: who.user?.name ?? null,
			email: who.user?.email ?? null,
			workspace: who.workspace?.name ?? null,
		};
		this.authNoticeShown = false;
		await this.saveAll();
		new Notice(`Connected to NoteAlong as ${this.data.account.email ?? this.data.account.name ?? "you"}. Syncing…`);
		this.schedule();
		void this.syncNow({ manual: true });
	}

	async disconnect(): Promise<void> {
		await this.tokens.clear();
		this.data.account = null;
		// Files stay; a later connection (maybe another account) starts fresh.
		this.data.sync = { ...this.data.sync, cursor: null, account: null };
		await this.saveAll();
		this.clearSchedule();
		this.renderStatus();
		new Notice("Disconnected. Your notes stay in the vault. You can also revoke the token in your NoteAlong settings.");
	}

	// ----------------------------------------------------------------- sync

	schedule(): void {
		this.clearSchedule();
		const minutes = this.data.settings.syncIntervalMinutes;
		if (minutes > 0 && this.tokens.get()) {
			this.intervalId = window.setInterval(() => void this.syncNow({ manual: false }), minutes * 60 * 1000);
			this.registerInterval(this.intervalId);
		}
	}

	private clearSchedule(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	async syncNow(options: { manual: boolean }): Promise<void> {
		if (!this.tokens.get()) {
			if (options.manual) new Notice("Connect NoteAlong first, in this plugin's settings.");
			return;
		}
		if (this.engine.busy) {
			if (options.manual) new Notice("NoteAlong is already syncing.");
			return;
		}
		const settings = this.data.settings;
		this.setStatus("NoteAlong: syncing…");
		try {
			const result = await this.engine.sync(
				this.data.sync,
				{
					root: normalizeRoot(settings.rootFolder),
					feed: {
						versions: settings.includeVersions,
						transcript: settings.includeTranscript,
						flashcards: settings.includeFlashcards,
					},
					deletedNotes: settings.deletedNotes,
				},
				{
					save: async (state) => {
						this.data.sync = state;
						await this.saveAll();
					},
					progress: (notes) => this.setStatus(`NoteAlong: syncing… ${notes}`),
				},
			);
			this.renderStatus();
			if (result.conflicts > 0) {
				new Notice(
					`NoteAlong: ${result.conflicts} note${result.conflicts === 1 ? "" : "s"} you edited changed in NoteAlong too. ` +
						`The update is in a "(NoteAlong update)" copy next to yours.`,
				);
			} else if (options.manual) {
				new Notice(`NoteAlong: ${describeResult(result)}.`);
			}
		} catch (error) {
			this.renderStatus();
			if (isAuthError(error)) {
				if (options.manual || !this.authNoticeShown) {
					this.authNoticeShown = true;
					new Notice("NoteAlong: the connection was revoked or expired. Connect again in settings.");
				}
				this.clearSchedule();
			} else if (options.manual) {
				new Notice(`NoteAlong sync failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	async restoreDeleted(): Promise<void> {
		const count = this.data.sync.removedByUser.length;
		// A full pass: the cursor is past those notes.
		this.data.sync = { ...this.data.sync, removedByUser: [], cursor: null };
		await this.saveAll();
		new Notice(count ? `Restoring ${count} note${count === 1 ? "" : "s"} on this sync.` : "Nothing to restore.");
		if (count) await this.syncNow({ manual: true });
	}

	// --------------------------------------------------------------- status

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
	}

	private renderStatus(): void {
		const sync = this.data.sync;
		if (!this.tokens?.get()) {
			this.setStatus("NoteAlong: not connected");
		} else if (sync.lastError) {
			this.setStatus("NoteAlong: sync failed");
		} else if (sync.lastSyncAt) {
			const time = new Date(sync.lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			this.setStatus(`NoteAlong: synced ${time}`);
		} else {
			this.setStatus("NoteAlong: not synced yet");
		}
	}
}
