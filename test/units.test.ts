import { describe, expect, test } from "vitest";
import { ApiError, NoteAlongApi, isAuthError, isCursorError } from "../src/api";
import {
	PROTOCOL_ACTION,
	extractPairingCode,
	freshNonce,
	looksLikeToken,
	makeNonce,
	normalizeServerUrl,
	pairingPageUrl,
} from "../src/pairing";
import { attachmentPath, normalizeRoot, vaultPath } from "../src/paths";
import { MockServer, response } from "./mock-server";

describe("paths", () => {
	test("root normalisation", () => {
		expect(normalizeRoot(" /Inbox//NoteAlong/ ")).toBe("Inbox/NoteAlong");
		expect(normalizeRoot("")).toBe("NoteAlong");
		expect(normalizeRoot("../x")).toBe("x");
	});
	test("feed path → vault path, refusing anything outside the export root", () => {
		expect(vaultPath("NoteAlong/A/B.md", "Notes")).toBe("Notes/A/B.md");
		expect(vaultPath("NoteAlong/B.md", "NoteAlong")).toBe("NoteAlong/B.md");
		expect(vaultPath("Other/B.md", "Notes")).toBeNull();
		expect(vaultPath("NoteAlong/../x.md", "Notes")).toBeNull();
		expect(vaultPath("NoteAlong", "Notes")).toBeNull();
	});
	test("attachment names are token-free and flat", () => {
		expect(attachmentPath("Notes", "na-0123456789.png")).toBe("Notes/_attachments/na-0123456789.png");
		expect(attachmentPath("Notes", "../x.png")).toBeNull();
		expect(attachmentPath("Notes", ".hidden")).toBeNull();
	});
});

describe("pairing", () => {
	test("the protocol action matches the API's obsidianUrl (obsidian://notealong-auth?code=…)", () => {
		expect(PROTOCOL_ACTION).toBe("notealong-auth");
	});
	test("codes from a paste or the whole link", () => {
		const code = "na_pair_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
		expect(extractPairingCode(` ${code} `)).toBe(code);
		expect(extractPairingCode(`obsidian://notealong-auth?code=${encodeURIComponent(code)}`)).toBe(code);
		expect(extractPairingCode("hello")).toBeNull();
		expect(extractPairingCode("na_pat_x")).toBeNull();
	});
	test("nonce shape is what the web accepts (?pair=, 16–128 url-safe)", () => {
		const nonce = makeNonce();
		expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
		expect(makeNonce()).not.toBe(nonce);
		expect(freshNonce({ nonce, at: 1000 }, 1000 + 60_000)).toBe(nonce);
		expect(freshNonce({ nonce, at: 1000 }, 1000 + 16 * 60_000)).toBeNull();
		expect(freshNonce(null)).toBeNull();
	});
	test("codes from a link that names the vault", () => {
		const code = "na_pair_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
		expect(extractPairingCode(`obsidian://notealong-auth?vault=My%20Vault%20%26%20Co&code=${code}`)).toBe(code);
		expect(extractPairingCode(`obsidian://notealong-auth?code=${code}&vault=My%20Vault`)).toBe(code);
	});
	test("urls", () => {
		expect(pairingPageUrl("https://notealong.com/", "abc")).toBe("https://notealong.com/app/settings?pair=abc");
		expect(normalizeServerUrl("https://api.example.org/", "x")).toBe("https://api.example.org");
		expect(normalizeServerUrl("ftp://x", "fallback")).toBe("fallback");
		expect(looksLikeToken("na_pat_0123456789abcdefghij")).toBe(true);
		expect(looksLikeToken("na_pair_0123456789abcdefghij")).toBe(false);
	});
	test("the pairing page carries the vault name so the link comes back to this vault", () => {
		expect(pairingPageUrl("https://notealong.com", "abc", "NoteAlong Test Vault")).toBe(
			"https://notealong.com/app/settings?pair=abc&vault=NoteAlong%20Test%20Vault",
		);
		for (const vault of ["a&pair=evil", "Notes #1 + more?", "Ünïcødé 日本語", "100% sure"]) {
			const url = new URL(pairingPageUrl("https://notealong.com", "abc", vault));
			expect(url.searchParams.get("vault")).toBe(vault);
			expect(url.searchParams.getAll("pair")).toEqual(["abc"]);
		}
		// No vault name: the old page URL.
		expect(pairingPageUrl("https://notealong.com", "abc", "")).toBe("https://notealong.com/app/settings?pair=abc");
	});
});

describe("api client", () => {
	const make = (server: MockServer, token: string | null = server.token) =>
		new NoteAlongApi(server.request, () => "http://api.test/", () => token, async () => undefined);

	test("exchange sends code + nonce + name, no auth header", async () => {
		const server = new MockServer();
		const result = await make(server, null).exchangePairing({ code: "na_pair_GOODCODE0123456789", nonce: "N".repeat(32), name: "Obsidian (Vault)" });
		expect(result.token).toBe(server.token);
		const call = server.calls[0];
		expect(call.method).toBe("POST");
		expect(call.headers?.Authorization).toBeUndefined();
		expect(JSON.parse(call.body!)).toEqual({ code: "na_pair_GOODCODE0123456789", nonce: "N".repeat(32), name: "Obsidian (Vault)" });
		await expect(make(server, null).exchangePairing({ code: "na_pair_BADCODE012345678" })).rejects.toMatchObject({
			status: 400,
			code: "invalid_pairing_code",
			message: "expired",
		});
	});

	test("bearer auth, error classification", async () => {
		const server = new MockServer();
		await make(server).whoami();
		expect(server.calls[0].headers?.Authorization).toBe(`Bearer ${server.token}`);
		const denied = await make(server, "na_pat_wrongwrongwrongwrong").whoami().catch((e: unknown) => e);
		expect(isAuthError(denied)).toBe(true);
		expect(isCursorError(new ApiError(410, "resync_required", ""))).toBe(true);
		expect(isCursorError(new ApiError(400, "invalid_cursor", ""))).toBe(true);
		expect(isCursorError(new ApiError(400, "bad", ""))).toBe(false);
	});

	test("retries network failures and 5xx, then gives up with a clear error", async () => {
		let n = 0;
		const flaky = async () => {
			n += 1;
			if (n < 3) throw new Error("ECONNRESET");
			return response(200, { user: null, workspace: null });
		};
		await new NoteAlongApi(flaky, () => "http://x", () => "t", async () => undefined).whoami();
		expect(n).toBe(3);
		const down = async () => response(503, "Service Unavailable");
		await expect(new NoteAlongApi(down, () => "http://x", () => "t", async () => undefined).whoami()).rejects.toMatchObject({ status: 503 });
	});

	test("attachments resolve relative feed urls against the server", async () => {
		const server = new MockServer();
		const bytes = await make(server).attachment("/v1/export/notes/n1/attachments/na-0123456789.png");
		expect(new TextDecoder().decode(bytes)).toBe("PNG!");
		expect(server.calls[0].url).toBe("http://api.test/v1/export/notes/n1/attachments/na-0123456789.png");
	});
});
