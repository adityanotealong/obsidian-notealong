import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NoteAlongPlugin from "./main";
import { DEFAULT_ROOT, normalizeRoot } from "./paths";
import { describeResult } from "./sync";

export interface NoteAlongSettings {
	serverUrl: string;
	appUrl: string;
	rootFolder: string;
	/** Minutes between automatic syncs; 0 = only on startup and by hand. */
	syncIntervalMinutes: number;
	syncOnStartup: boolean;
	includeVersions: boolean;
	includeTranscript: boolean;
	includeFlashcards: boolean;
	deletedNotes: "mark" | "trash";
}

export const DEFAULT_SERVER_URL = "https://api.notealong.com";
export const DEFAULT_APP_URL = "https://notealong.com";

export const DEFAULT_SETTINGS: NoteAlongSettings = {
	serverUrl: DEFAULT_SERVER_URL,
	appUrl: DEFAULT_APP_URL,
	rootFolder: DEFAULT_ROOT,
	syncIntervalMinutes: 30,
	syncOnStartup: true,
	includeVersions: true,
	includeTranscript: true,
	includeFlashcards: true,
	deletedNotes: "mark",
};

const INTERVALS: [string, string][] = [
	["0", "Off (startup and by hand)"],
	["15", "Every 15 minutes"],
	["30", "Every 30 minutes"],
	["60", "Every hour"],
	["240", "Every 4 hours"],
];

export class NoteAlongSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: NoteAlongPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const plugin = this.plugin;
		containerEl.empty();

		// ------------------------------------------------------------ account
		new Setting(containerEl).setName("Account").setHeading();
		const account = plugin.accountLabel();
		if (account) {
			new Setting(containerEl)
				.setName("Connected")
				.setDesc(account)
				.addButton((button) =>
					button.setButtonText("Disconnect").onClick(async () => {
						await plugin.disconnect();
						this.display();
					}),
				);
		} else {
			new Setting(containerEl)
				.setName("Connect NoteAlong")
				.setDesc(
					"Opens NoteAlong in your browser. Approve there and Obsidian finishes on its own. Needs a NoteAlong account.",
				)
				.addButton((button) =>
					button
						.setCta()
						.setButtonText("Connect")
						.onClick(() => plugin.startPairing()),
				);
			let code = "";
			new Setting(containerEl)
				.setName("Pairing code")
				.setDesc("Didn't switch back to Obsidian? Paste the code NoteAlong shows (it works for 10 minutes).")
				.addText((text) => text.setPlaceholder("Pairing code").onChange((value) => (code = value)))
				.addButton((button) =>
					button.setButtonText("Use code").onClick(async () => {
						if (await plugin.completePairing(code)) this.display();
					}),
				);
			let token = "";
			new Setting(containerEl)
				.setName("Access token")
				.setDesc("Or paste a token from NoteAlong: settings, connections, API tokens.")
				.addText((text) => {
					text.inputEl.type = "password";
					text.setPlaceholder("Token").onChange((value) => (token = value));
				})
				.addButton((button) =>
					button.setButtonText("Use token").onClick(async () => {
						if (await plugin.useToken(token)) this.display();
					}),
				);
		}

		// --------------------------------------------------------------- sync
		new Setting(containerEl).setName("Sync").setHeading();
		const state = plugin.data.sync;
		const last = state.lastSyncAt
			? `Last synced ${new Date(state.lastSyncAt).toLocaleString()}${
					state.lastResult ? ` (${describeResult(state.lastResult)})` : ""
				}.`
			: "Not synced yet.";
		new Setting(containerEl)
			.setName("Sync now")
			.setDesc(state.lastError ? `${last} Last error: ${state.lastError}` : last)
			.addButton((button) =>
				button
					.setButtonText("Sync now")
					.setDisabled(!account)
					.onClick(async () => {
						await plugin.syncNow({ manual: true });
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Folder")
			.setDesc("Where your notes go. Images go in its _attachments folder. Changing it starts a fresh copy there.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_ROOT)
					.setValue(plugin.data.settings.rootFolder)
					.onChange(async (value) => {
						plugin.data.settings.rootFolder = normalizeRoot(value);
						await plugin.saveAll();
					}),
			);

		new Setting(containerEl)
			.setName("Sync automatically")
			.setDesc("While Obsidian is open.")
			.addDropdown((dropdown) => {
				for (const [value, label] of INTERVALS) dropdown.addOption(value, label);
				dropdown.setValue(String(plugin.data.settings.syncIntervalMinutes)).onChange(async (value) => {
					plugin.data.settings.syncIntervalMinutes = Number(value);
					await plugin.saveAll();
					plugin.schedule();
				});
			});

		new Setting(containerEl).setName("Sync when Obsidian starts").addToggle((toggle) =>
			toggle.setValue(plugin.data.settings.syncOnStartup).onChange(async (value) => {
				plugin.data.settings.syncOnStartup = value;
				await plugin.saveAll();
			}),
		);

		const contentToggle = (name: string, desc: string, key: "includeTranscript" | "includeFlashcards" | "includeVersions") =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((toggle) =>
					toggle.setValue(plugin.data.settings[key]).onChange(async (value) => {
						plugin.data.settings[key] = value;
						await plugin.saveAll();
						new Notice("NoteAlong will update your notes on the next sync.");
					}),
				);
		contentToggle("Transcript", "Include the transcript in each note.", "includeTranscript");
		contentToggle("Flashcards", "Include flashcards (Spaced Repetition plugin format).", "includeFlashcards");
		contentToggle("Language versions", "Also sync translated versions, as \"Title (es).md\".", "includeVersions");

		new Setting(containerEl)
			.setName("Notes deleted in NoteAlong")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("mark", "Keep the file, mark it deleted")
					.addOption("trash", "Move the file to the trash")
					.setValue(plugin.data.settings.deletedNotes)
					.onChange(async (value) => {
						plugin.data.settings.deletedNotes = value === "trash" ? "trash" : "mark";
						await plugin.saveAll();
					}),
			);

		const removed = state.removedByUser.length;
		new Setting(containerEl)
			.setName("Notes you deleted from the vault")
			.setDesc(
				removed
					? `${removed} note${removed === 1 ? "" : "s"} won't come back unless you restore them.`
					: "NoteAlong never brings back a note you deleted here.",
			)
			.addButton((button) =>
				button
					.setButtonText("Restore")
					.setDisabled(removed === 0)
					.onClick(async () => {
						await plugin.restoreDeleted();
						this.display();
					}),
			);

		// ----------------------------------------------------------- advanced
		new Setting(containerEl).setName("Advanced").setHeading();
		new Setting(containerEl)
			.setName("Server")
			.setDesc("The NoteAlong API. Leave as is unless you run a test server.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SERVER_URL)
					.setValue(plugin.data.settings.serverUrl)
					.onChange(async (value) => {
						plugin.data.settings.serverUrl = value.trim() || DEFAULT_SERVER_URL;
						await plugin.saveAll();
					}),
			);
		new Setting(containerEl)
			.setName("Web app")
			.setDesc("The NoteAlong web app the connect button opens.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_APP_URL)
					.setValue(plugin.data.settings.appUrl)
					.onChange(async (value) => {
						plugin.data.settings.appUrl = value.trim() || DEFAULT_APP_URL;
						await plugin.saveAll();
					}),
			);
	}
}
