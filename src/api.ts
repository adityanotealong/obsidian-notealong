/**
 * The NoteAlong API as the plugin uses it. Every call goes through an
 * injected `request` function with the shape of Obsidian's `requestUrl`
 * (main.ts passes the real one; tests pass a mock). `requestUrl` is not
 * subject to CORS on desktop or mobile, which `fetch` would be.
 *
 * Endpoints (https://api.notealong.com):
 * - POST /v1/integrations/pairing/exchange {code, nonce?, name?} → token
 *   (public; the 10-minute single-use code is the credential)
 * - GET  /v1/export/whoami                       (Bearer token)
 * - GET  /v1/export/changes?cursor=&limit=&…     (Bearer token)
 * - GET  /v1/export/notes/:noteId/attachments/:name (Bearer token)
 */

export interface HttpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	contentType?: string;
	throw?: boolean;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
}

export type RequestFn = (request: HttpRequest) => Promise<HttpResponse>;

export interface FeedAttachment {
	name: string;
	mime: string;
	size: number;
	url: string;
}

export interface FeedFile {
	language: string | null;
	version: boolean;
	fileName: string;
	/** `NoteAlong/<folders>/<name>.md` (the export root is always "NoteAlong"). */
	path: string;
	contentHash: string;
	markdown: string;
	attachments: FeedAttachment[];
}

export interface FeedNote {
	id: string;
	title: string;
	updatedAt: string;
	folderPath: string[];
	folderNames: string[];
	files: FeedFile[];
}

export interface FeedPage {
	notes: FeedNote[];
	deleted: { id: string; language: string | null; deletedAt: string }[];
	folders: { id: string; parentId: string | null; name: string; path: string[] }[];
	cursor: string;
	hasMore: boolean;
}

export interface WhoAmI {
	user: { id: string; name: string | null; email: string | null } | null;
	workspace: { id: string; name: string | null } | null;
}

export interface FeedOptions {
	versions: boolean;
	transcript: boolean;
	flashcards: boolean;
}

/** An API error with the server's `{error:{code,message}}` when present. */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

/** 401: the token was revoked or is wrong; sync must stop and ask to reconnect. */
export function isAuthError(error: unknown): boolean {
	return error instanceof ApiError && error.status === 401;
}

/** The cursor is too old (410) or unreadable (400 invalid_cursor): start over. */
export function isCursorError(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		(error.status === 410 || error.code === "invalid_cursor" || error.code === "resync_required")
	);
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export class NoteAlongApi {
	constructor(
		private readonly request: RequestFn,
		private readonly baseUrl: () => string,
		private readonly token: () => string | null,
		private readonly wait: (ms: number) => Promise<void> = sleep,
	) {}

	private url(path: string, query: Record<string, string | number | boolean | null | undefined> = {}): string {
		const base = this.baseUrl().replace(/\/+$/, "");
		const params = Object.entries(query)
			.filter(([, value]) => value !== null && value !== undefined)
			.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
		return `${base}${path}${params.length ? `?${params.join("&")}` : ""}`;
	}

	/**
	 * One call with `throw: false` so error bodies can be read. 429 and
	 * network/5xx failures retry with backoff (Retry-After honoured, capped).
	 */
	private async call(request: HttpRequest, auth: boolean): Promise<HttpResponse> {
		const headers: Record<string, string> = { ...(request.headers ?? {}) };
		if (auth) {
			const token = this.token();
			if (!token) throw new ApiError(401, "not_connected", "NoteAlong is not connected.");
			headers.Authorization = `Bearer ${token}`;
		}
		let lastError: unknown = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			let response: HttpResponse;
			try {
				response = await this.request({ ...request, headers, throw: false });
			} catch (error) {
				// Offline / DNS / TLS: retry a little, then give up.
				lastError = error;
				await this.wait(1000 * 2 ** attempt);
				continue;
			}
			if (response.status === 429 || response.status >= 500) {
				lastError = errorOf(response);
				const retryAfter = Number(headerValue(response.headers, "retry-after"));
				const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** attempt;
				if (attempt < 3) await this.wait(delay);
				continue;
			}
			if (response.status >= 400) throw errorOf(response);
			return response;
		}
		if (lastError instanceof ApiError) throw lastError;
		throw new ApiError(0, "network", "Couldn't reach NoteAlong. Check your connection.");
	}

	async exchangePairing(input: { code: string; nonce?: string | null; name?: string }): Promise<{
		token: string;
		id: string;
		workspace: { id: string; name: string | null } | null;
	}> {
		const body: Record<string, string> = { code: input.code.trim() };
		if (input.nonce) body.nonce = input.nonce;
		if (input.name) body.name = input.name.slice(0, 60);
		const response = await this.call(
			{
				url: this.url("/v1/integrations/pairing/exchange"),
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify(body),
			},
			false,
		);
		return response.json as { token: string; id: string; workspace: { id: string; name: string | null } | null };
	}

	async whoami(): Promise<WhoAmI> {
		const response = await this.call({ url: this.url("/v1/export/whoami") }, true);
		return response.json as WhoAmI;
	}

	async changes(cursor: string | null, options: FeedOptions, limit = 25): Promise<FeedPage> {
		const response = await this.call(
			{
				url: this.url("/v1/export/changes", {
					cursor,
					limit,
					versions: options.versions,
					transcript: options.transcript,
					flashcards: options.flashcards,
				}),
			},
			true,
		);
		return response.json as FeedPage;
	}

	/** Image bytes; `url` is the path from the feed (`/v1/export/notes/…`). */
	async attachment(url: string): Promise<ArrayBuffer> {
		const absolute = /^https?:\/\//.test(url) ? url : this.url(url.startsWith("/") ? url : `/${url}`);
		const response = await this.call({ url: absolute }, true);
		return response.arrayBuffer;
	}
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name);
	return key ? headers[key] : undefined;
}

function errorOf(response: HttpResponse): ApiError {
	let code = `http_${response.status}`;
	let message = `NoteAlong answered ${response.status}.`;
	try {
		const parsed = (response.json ?? JSON.parse(response.text)) as {
			error?: { code?: string; message?: string };
			code?: string;
			message?: string;
		};
		code = parsed?.error?.code ?? parsed?.code ?? code;
		message = parsed?.error?.message ?? parsed?.message ?? message;
	} catch {
		// not JSON
	}
	return new ApiError(response.status, code, message);
}
