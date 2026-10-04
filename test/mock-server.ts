/**
 * A tiny in-memory NoteAlong API behind a mocked `requestUrl`: the change
 * feed (keyset cursor + hasMore paging + tombstones), whoami, attachments,
 * pairing exchange, and injectable failures (410, 400 invalid_cursor, 401,
 * 429). Mirrors the response shapes of the NoteAlong export API.
 */
import type { FeedFile, HttpRequest, HttpResponse, RequestFn } from "../src/api";

export interface MockNote {
	id: string;
	title: string;
	files: FeedFile[];
	seq: number;
}

export function response(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	const bytes = new TextEncoder().encode(text);
	return {
		status,
		headers,
		text,
		get json() {
			return JSON.parse(text) as unknown;
		},
		arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	};
}

/** Note markdown the way the server renders it (frontmatter + body + My notes). */
export function render(id: string, title: string, body: string, extra: { version?: string; tags?: string[] } = {}): string {
	const lines = [
		"---",
		`title: ${title}`,
		"tags:",
		...(extra.tags ?? ["notealong"]).map((tag) => `  - ${tag}`),
		`notealong_id: ${id}`,
		...(extra.version ? [`notealong_version: ${extra.version}`] : []),
		"---",
		"",
		`# ${title}`,
		"",
		body,
		"",
		"## My notes",
		"%% notealong:keep — anything below this line is never changed by NoteAlong sync %%",
		"",
	];
	return lines.join("\n");
}

export function file(id: string, title: string, path: string, body: string, extra: { version?: string; attachments?: string[] } = {}): FeedFile {
	return {
		language: extra.version ?? null,
		version: !!extra.version,
		fileName: path.split("/").pop()!,
		path,
		contentHash: `${id}:${body.length}`,
		markdown: render(id, title, body, { version: extra.version }),
		attachments: (extra.attachments ?? []).map((name) => ({
			name,
			mime: "image/png",
			size: 4,
			url: `/v1/export/notes/${id}/attachments/${name}`,
		})),
	};
}

export class MockServer {
	notes = new Map<string, MockNote>();
	tombstones: { id: string; language: string | null; seq: number; deletedAt: string }[] = [];
	seq = 0;
	token = "na_pat_TESTTOKEN0123456789abcdefghijklmnopqrstuvwx";
	/** Responses to return (in order) before normal handling, by path prefix. */
	failures: { path: string; status: number; body?: unknown; headers?: Record<string, string> }[] = [];
	calls: HttpRequest[] = [];
	attachmentCalls = 0;

	put(id: string, title: string, files: FeedFile[]): void {
		this.seq += 1;
		this.notes.set(id, { id, title, files, seq: this.seq });
	}

	remove(id: string, language: string | null = null): void {
		this.seq += 1;
		if (language === null) this.notes.delete(id);
		this.tombstones.push({ id, language, seq: this.seq, deletedAt: "2026-10-05T10:00:00.000Z" });
	}

	readonly request: RequestFn = async (request) => {
		this.calls.push(request);
		const url = new URL(request.url);
		const failure = this.failures.findIndex((f) => url.pathname.startsWith(f.path));
		if (failure !== -1) {
			const [f] = this.failures.splice(failure, 1);
			return response(f.status, f.body ?? { error: { code: `http_${f.status}`, message: "fail" } }, f.headers);
		}
		if (url.pathname === "/v1/integrations/pairing/exchange") {
			const body = JSON.parse(request.body ?? "{}") as { code?: string };
			if (body.code !== "na_pair_GOODCODE0123456789") {
				return response(400, { error: { code: "invalid_pairing_code", message: "expired" } });
			}
			return response(200, { token: this.token, id: "tok1", workspace: { id: "ws1", name: "Mine" } });
		}
		if (request.headers?.Authorization !== `Bearer ${this.token}`) {
			return response(401, { error: { code: "invalid_token", message: "Invalid token" } });
		}
		if (url.pathname === "/v1/export/whoami") {
			return response(200, { user: { id: "u1", name: "Test", email: "t@example.com" }, workspace: { id: "ws1", name: "Mine" } });
		}
		if (url.pathname.startsWith("/v1/export/notes/")) {
			this.attachmentCalls += 1;
			return response(200, "PNG!");
		}
		if (url.pathname === "/v1/export/changes") {
			const raw = url.searchParams.get("cursor");
			if (raw !== null && !/^c\d+$/.test(raw)) {
				return response(400, { error: { code: "invalid_cursor", message: "bad cursor" } });
			}
			const after = raw ? Number(raw.slice(1)) : 0;
			const limit = Number(url.searchParams.get("limit") ?? 25);
			const changed = [...this.notes.values()].filter((n) => n.seq > after).sort((a, b) => a.seq - b.seq);
			const page = changed.slice(0, limit);
			const hasMore = changed.length > limit;
			const until = hasMore ? page[page.length - 1].seq : this.seq;
			const deleted = this.tombstones
				.filter((t) => t.seq > after && t.seq <= until)
				.map(({ id, language, deletedAt }) => ({ id, language, deletedAt }));
			return response(200, {
				notes: page.map((n) => ({
					id: n.id,
					title: n.title,
					updatedAt: "2026-10-05T09:00:00.000Z",
					folderPath: [],
					folderNames: [],
					files: n.files,
				})),
				deleted,
				folders: [],
				cursor: `c${until}`,
				hasMore,
			});
		}
		return response(404, { error: { code: "not_found", message: url.pathname } });
	};
}
