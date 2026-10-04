/**
 * Pairing helpers (pure). The flow:
 * 1. "Connect" opens `<app>/app/settings?pair=<nonce>&vault=<vault name>`;
 *    the signed-in NoteAlong web app mints a 10-minute single-use code bound
 *    to that nonce and opens
 *    `obsidian://notealong-auth?vault=<vault name>&code=na_pair_…`.
 *    Obsidian's `vault` parameter sends the link to THIS vault even when
 *    several vaults are open (without it, Obsidian picks the last-used one).
 * 2. Our protocol handler ("notealong-auth") trades code + nonce for a
 *    personal token: POST /v1/integrations/pairing/exchange.
 * A code minted without a nonce (the user clicked "Connect the plugin" on
 * the web first) works with or without ours. The code can also be pasted.
 */

export const PROTOCOL_ACTION = "notealong-auth";
export const PAIR_NONCE_TTL_MS = 15 * 60 * 1000;

/** The API's pairing-code and token shapes. */
const CODE_RE = /^na_pair_[A-Za-z0-9_-]{8,128}$/;
const TOKEN_RE = /^na_pat_[A-Za-z0-9_-]{16,128}$/;

/** 32 url-safe random characters (the web accepts 16–128 of [A-Za-z0-9_-]). */
export function makeNonce(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const bytes = random(new Uint8Array(32));
	let out = "";
	for (const byte of bytes) out += alphabet[byte & 63];
	return out;
}

/**
 * A pasted pairing code, or the whole `obsidian://notealong-auth?code=…`
 * link someone copied → the code; null when it isn't one.
 */
export function extractPairingCode(input: string): string | null {
	const trimmed = input.trim();
	const fromUrl = /[?&]code=([^&\s#]+)/.exec(trimmed);
	let candidate = trimmed;
	if (fromUrl) {
		try {
			candidate = decodeURIComponent(fromUrl[1]);
		} catch {
			return null;
		}
	}
	return CODE_RE.test(candidate) ? candidate : null;
}

export function looksLikeToken(input: string): boolean {
	return TOKEN_RE.test(input.trim());
}

/** The nonce to send with an exchange, if the one we opened is still fresh. */
export function freshNonce(pending: { nonce: string; at: number } | null, now = Date.now()): string | null {
	if (!pending) return null;
	return now - pending.at <= PAIR_NONCE_TTL_MS ? pending.nonce : null;
}

/** "https://api.notealong.com/" → "https://api.notealong.com"; must be http(s). */
export function normalizeServerUrl(input: string, fallback: string): string {
	const trimmed = input.trim().replace(/\/+$/, "");
	if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) return fallback;
	return trimmed;
}

/**
 * The web page that pairs a plugin. `vault` (the vault's name) comes back in
 * the obsidian:// link so Obsidian opens this vault, not the last-used one.
 */
export function pairingPageUrl(appUrl: string, nonce: string, vault?: string | null): string {
	const base = `${appUrl.replace(/\/+$/, "")}/app/settings?pair=${encodeURIComponent(nonce)}`;
	return vault ? `${base}&vault=${encodeURIComponent(vault)}` : base;
}
