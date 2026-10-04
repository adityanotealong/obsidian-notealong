# NoteAlong for Obsidian

Your [NoteAlong](https://notealong.com) lecture notes, in your vault, kept up to date.

NoteAlong turns lectures, YouTube videos and recordings into study notes with flashcards. This plugin pulls those notes into a folder of your vault as plain Markdown files, with their images, and keeps them in sync. It works on desktop and on iOS and Android.

## What you get

- One Markdown file per note under `NoteAlong/` (or a folder you choose), in the same folders you use in NoteAlong. Properties include the source, date, language and a link back to the note.
- Images from your notes in `NoteAlong/_attachments/`, linked with ordinary relative links (no remote URLs).
- Optional: the transcript, flashcards in [Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) format, and language versions of a note as `Title (es).md`.
- Sync on startup, on a timer, with the **Sync now** command or the ribbon button. The status bar shows the last sync.

## Your edits are safe

- Write your own thoughts under **My notes** at the end of each file. Sync never touches that section.
- Properties and tags you add are kept. Spaced Repetition review data (`<!--SR:…-->`) is kept.
- If you edit the part NoteAlong wrote and the note then changes in NoteAlong, your file is left alone and the update is written next to it as `Title (NoteAlong update).md`.
- Rename or move a file in your vault and sync follows it. Delete it and it stays deleted (use **Restore notes deleted from the vault** to bring them back).
- A note deleted in NoteAlong keeps its file, marked `notealong_deleted: <date>`. You can choose to move such files to the trash instead.

## Install

1. In Obsidian, open **Settings → Community plugins → Browse**, search for **NoteAlong**, select **Install**, then **Enable**.
2. Open **Settings → NoteAlong** and select **Connect**. NoteAlong opens in your browser; approve there and Obsidian finishes on its own, in the vault you connected from.
3. Didn't switch back? Paste the pairing code NoteAlong shows into **Pairing code**. You can also paste a personal access token from NoteAlong → Settings → Connections.

Each vault connects on its own: run **Connect** in every vault you want your notes in.

**Manual install.** Download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest), put them in `<your vault>/.obsidian/plugins/notealong/`, then reload Obsidian and enable **NoteAlong** under Community plugins.

**Beta versions.** With the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, choose **Add a beta plugin for testing** and enter this repository's GitHub path. BRAT installs and updates pre-releases.

## Requirements and disclosures

- **Account required.** You need a NoteAlong account (free to create). The plugin only shows notes you made in NoteAlong.
- **Free.** The plugin is free, and so is syncing. NoteAlong itself has a free plan and a paid plan; making new notes beyond the free plan's monthly allowance needs the paid plan. The plugin has no ads.
- **Network use.** The plugin talks only to the NoteAlong API at `https://api.notealong.com` (or the server you set under Advanced):
  - to trade a pairing code for an access token (`POST /v1/integrations/pairing/exchange`), sending the code and a label for the token: "Obsidian (*your vault's name*)";
  - to read which account is connected (`GET /v1/export/whoami`);
  - to fetch your notes as Markdown, page by page (`GET /v1/export/changes`);
  - to download the images in your notes (`GET /v1/export/notes/<id>/attachments/<name>`).

  **Connect** opens `https://notealong.com` in your browser with a one-time random value and your vault's name, so the link NoteAlong sends back opens this vault. Nothing is ever uploaded from your vault: the plugin only reads from NoteAlong.
- **Data fetched.** Your notes' titles, folder names, Markdown content, images, and (if enabled) transcripts, flashcards and language versions.
- **No telemetry.** The plugin collects no analytics and sends nothing about your vault's contents. The NoteAlong API records when your token was last used (shown in NoteAlong's settings). See the [privacy policy](https://notealong.com/privacy).
- **Credentials.** The access token is read-only (it can only export your notes) and is stored in Obsidian's keychain (Settings → Keychain). Only if the keychain isn't available is it kept in the plugin's data file in your vault. Revoke it any time in NoteAlong → Settings → Connections; **Disconnect** removes it from Obsidian.
- **Files.** The plugin writes only inside the folder you choose (default `NoteAlong/`). It reads the Markdown files in that folder to find notes you moved. It never reads or changes files outside that folder.

## Development

```sh
npm install
npm run dev        # watch build to main.js
npm run build      # typecheck + production build (main.js)
npm test           # unit tests (vitest), against an in-memory mock of the API
npm run lint       # eslint with eslint-plugin-obsidianmd
```

Releases are built by GitHub Actions from a tag equal to the `version` in `manifest.json` (no `v` prefix); `main.js`, `manifest.json` and `styles.css` are attached to the release.

## License

[MIT](LICENSE)
