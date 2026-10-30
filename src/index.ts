/**
 * pi-deepseek-api — direct, high-fidelity access to DeepSeek's Search & Fetch APIs.
 *
 * Why this exists: pi-web-access maps DeepSeek's Search API onto a generic provider
 * interface, which drops `date`, `authority` and `rerank_score`, never sends
 * `ori_question`, clamps results to 20 without exposing `count`, does not retry, and
 * fails the whole call (without routing onward) on queries over 128 characters.
 * This extension registers its own tools, so it coexists with pi-web-access.
 *
 * Tools:
 *   deepseek_search — POST /v1/tools/search
 *   deepseek_fetch  — POST /v1/tools/fetch
 *
 * Auth: pi's `deepseek` provider credentials (ctx.modelRegistry), then DEEPSEEK_API_KEY.
 * Endpoint override: PI_DEEPSEEK_BASE_URL, then DEEPSEEK_SEARCH_BASE_URL.
 *
 * Docs: https://api-docs.deepseek.com/guides/search
 * API reference snapshot used for validation: 2026-10-30.
 */

import { isIP } from "node:net";

export const DOCS_SNAPSHOT = "2026-10-30";
export const PRICE_PER_SUCCESSFUL_REQUEST_USD = 0.00075;
export const MAX_QUERY_CHARS = 128;

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const MAX_ORI_QUESTION_CHARS = 128;
const MAX_RESULT_CONTENT_CHARS = 4_000;
const MAX_FETCH_CONTENT_CHARS = 20_000;

export interface SearchOptions {
	query: string;
	count: number;
	need_content: boolean;
	ori_question?: string;
	localization?: string;
	allowedDomains: string[];
	blockedDomains: string[];
	lang?: string;
	recency?: "day" | "week" | "month" | "year";
}

interface DeepSeekResult {
	rerank_score?: number;
	title?: string;
	url?: string;
	snippet?: string;
	summary?: string;
	content?: string;
	site_name?: string | null;
	date?: string | null;
	authority?: number;
}

class DeepSeekHttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "DeepSeekHttpError";
		this.status = status;
	}
}

/* ---------------------------------------------------------------- transport */

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const REDACT = (text: string, key: string | undefined): string =>
	key && key.length > 8 ? text.split(key).join("[redacted]") : text;

const charLength = (value: string): number => Array.from(value).length;

export function baseUrl(): string {
	const configured =
		process.env.PI_DEEPSEEK_BASE_URL ?? process.env.DEEPSEEK_SEARCH_BASE_URL ?? DEFAULT_BASE_URL;
	return configured.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function resolveApiKey(ctx: any): Promise<string> {
	const fromPi = await ctx?.modelRegistry?.getApiKeyForProvider?.("deepseek");
	const key =
		typeof fromPi === "string" && fromPi.trim() ? fromPi.trim() : process.env.DEEPSEEK_API_KEY?.trim();
	if (!key) {
		throw new Error(
			"DeepSeek API key not found. Either:\n" +
				"  1. Configure the `deepseek` provider in pi (/login), or\n" +
				"  2. Set DEEPSEEK_API_KEY in the environment\n" +
				"Get a key at https://platform.deepseek.com/api_keys",
		);
	}
	return key;
}

/** Documented per-status guidance, so a failure is actionable instead of opaque. */
export function errorHint(status: number, path: "/v1/tools/search" | "/v1/tools/fetch"): string {
	if (status === 401)
		return "\nHint: the DeepSeek API key is missing or invalid (pi `deepseek` provider or DEEPSEEK_API_KEY).";
	if (status === 402)
		return "\nHint: the account has insufficient balance — top up at https://platform.deepseek.com/top_up and retry.";
	if (status === 403 && path === "/v1/tools/fetch")
		return "\nHint: DeepSeek's Fetch security policy rejected this URL.";
	if (status === 404 && path === "/v1/tools/fetch")
		return "\nHint: no usable page content (target unavailable, blocked, unsupported type, or an error page).";
	if (status === 413) return "\nHint: the request body was too large; shorten the URL or query.";
	if (status === 429)
		return "\nHint: rate limit (100 QPS search / 25 QPS fetch account-wide, plus a per-domain fetch limit). Retry after a pause.";
	return "";
}

function retryDelayMs(response: Response, attempt: number): number {
	const header = response.headers.get("retry-after");
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
		const at = Date.parse(header);
		if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 5_000);
	}
	return 500 * 2 ** attempt;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Aborted"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

async function postDeepSeek<T>(
	path: "/v1/tools/search" | "/v1/tools/fetch",
	body: Record<string, unknown>,
	apiKey: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<T> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const timeout = AbortSignal.timeout(timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await fetch(`${baseUrl()}${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(body),
				redirect: "error",
				signal: requestSignal,
			});
		} catch (err) {
			if (signal?.aborted) throw new Error("Aborted");
			if (timeout.aborted) {
				lastError = new Error(`DeepSeek ${path} timed out after ${Math.round(timeoutMs / 1000)}s`);
			} else {
				const message = err instanceof Error ? err.message : String(err);
				lastError = new Error(`DeepSeek ${path} request failed: ${REDACT(message, apiKey)}`);
			}
			if (attempt < MAX_ATTEMPTS - 1) {
				await sleep(500 * 2 ** attempt, signal);
				continue;
			}
			throw lastError;
		}

		if (response.ok) {
			try {
				return (await response.json()) as T;
			} catch {
				throw new Error(`DeepSeek ${path} returned invalid JSON`);
			}
		}

		const raw = await response.text().catch(() => "");
		let message = raw;
		try {
			const parsed = JSON.parse(raw) as { error?: { message?: string } };
			message = parsed.error?.message?.trim() || raw;
		} catch {}
		message = REDACT(message.slice(0, 400), apiKey);

		const error = new DeepSeekHttpError(
			response.status,
			`DeepSeek ${path} failed (HTTP ${response.status}): ${message}${errorHint(response.status, path)}`,
		);
		if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
			lastError = error;
			await sleep(retryDelayMs(response, attempt), signal);
			continue;
		}
		throw error;
	}
	throw lastError ?? new Error(`DeepSeek ${path} failed`);
}

/* ------------------------------------------------------------------- query */

/**
 * Trim to the API's hard character budget (docs: 1-128 Unicode characters including
 * operators). Filters are shed first — recency, then language, then domains — and only
 * then trailing free-text words. Every removal is reported so the caller can see that
 * the request differs from what was asked for.
 */
export function fitQuery(options: SearchOptions): { query: string; dropped: string[] } {
	const dropped: string[] = [];
	const filters: string[] = [];
	if (options.allowedDomains.length > 0) {
		filters.push(options.allowedDomains.map((d) => `site:${d}`).join(" OR "));
	}
	for (const domain of options.blockedDomains) filters.push(`-site:${domain}`);
	if (options.lang) filters.push(`lang:${options.lang}`);
	if (options.recency) {
		const days = { day: 1, week: 7, month: 30, year: 365 }[options.recency];
		filters.push(`after:${new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)}`);
	}

	const assemble = (words: string[], activeFilters: string[]): string =>
		[words.join(" "), ...activeFilters].filter(Boolean).join(" ");

	let words = options.query.trim().split(/\s+/);
	let active = [...filters];

	if (charLength(assemble(words, active)) <= MAX_QUERY_CHARS) {
		return { query: assemble(words, active), dropped };
	}

	const overBudget = () => charLength(assemble(words, active)) > MAX_QUERY_CHARS;
	const dropFilter = (predicate: (filter: string) => boolean, label: (filter: string) => string): void => {
		const index = active.findIndex(predicate);
		if (index < 0 || !overBudget()) return;
		const [removed] = active.splice(index, 1);
		dropped.push(label(removed!));
	};

	dropFilter((f) => f.startsWith("after:"), (f) => `recency (${f})`);
	dropFilter((f) => f.startsWith("lang:"), (f) => `language (${f})`);
	while (overBudget() && active.length > 0) {
		const removed = active.pop()!;
		dropped.push(`domain filter (${removed.slice(0, 40)})`);
	}

	const wordsBefore = words.join(" ");
	while (words.length > 1 && overBudget()) words = words.slice(0, -1);
	if (words.join(" ") !== wordsBefore) dropped.push("trailing query words");

	let query = assemble(words, active);
	if (charLength(query) > MAX_QUERY_CHARS) {
		query = Array.from(query).slice(0, MAX_QUERY_CHARS).join("").trim();
		dropped.push("query tail");
	}
	return { query, dropped };
}

/** Docs: 1-128 Unicode characters and must not be all whitespace. */
export function assertQueryText(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error("query must not be empty or all whitespace.");
	return trimmed;
}

/** Docs: `localization` is "an optional IP address used to localize search results". */
export function assertLocalization(value: string): string {
	const trimmed = value.trim();
	if (isIP(trimmed) === 0)
		throw new Error(`localization must be an IP address, got ${JSON.stringify(trimmed)}.`);
	return trimmed;
}

/** Docs: http(s), a host, no credentials, at most 8192 characters. */
export function assertFetchableUrl(raw: string): URL {
	if (raw.length > 8192) throw new Error("url must be at most 8192 characters.");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("url must be a valid HTTP(S) URL with a host.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must use http or https.");
	if (url.username || url.password) throw new Error("url must not contain credentials.");

	// Extra safety beyond the docs: DeepSeek fetches server-side, so refuse to hand it
	// intranet targets. Local/private ranges only; public hosts are unaffected.
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const isPrivate =
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "::1" ||
		host === "::" ||
		/^127\./.test(host) ||
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
		/^169\.254\./.test(host) ||
		/^0\./.test(host) ||
		/^f[cd][0-9a-f]{2}:/.test(host) ||
		/^fe80:/.test(host);
	if (isPrivate) throw new Error("url must not target a local or private address.");
	return url;
}

/** DeepSeek Fetch over-escapes punctuation that was already plain text. */
export function cleanMarkdown(markdown: string): string {
	let fence: { char: string; length: number } | null = null;
	return markdown
		.split("\n")
		.map((line) => {
			const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
			if (marker) {
				const token = marker[1]!;
				if (fence === null) {
					fence = { char: token[0]!, length: token.length };
				} else if (
					token[0] === fence.char &&
					token.length >= fence.length &&
					line.slice(marker[0].length).trim() === ""
				) {
					fence = null;
				}
				return line;
			}
			// Inside a fenced block, escapes are real syntax: leave the line untouched.
			if (fence !== null) return line;
			return line
				.split(/(`+[^`]*`+)/g)
				.map((part, index) =>
					index % 2 === 0 ? part.replace(/\\([/.,:()&+#>|!_\-"'])/g, "$1") : part,
				)
				.join("");
		})
		.join("\n");
}

/* ---------------------------------------------------------------- rendering */

export function formatResult(result: DeepSeekResult, index: number, withContent: boolean): string {
	const lines: string[] = [];
	lines.push(`${index + 1}. ${(result.title ?? "").trim() || "(untitled)"}`);
	lines.push(`   ${result.url}`);

	const meta: string[] = [];
	if (result.site_name) meta.push(result.site_name);
	if (result.date) meta.push(result.date.slice(0, 10));
	if (typeof result.authority === "number") {
		// Docs: 0-4, where -1 means the tier is unknown.
		meta.push(result.authority < 0 ? "authority unknown" : `authority ${result.authority}/4`);
	}
	if (typeof result.rerank_score === "number") {
		meta.push(`score ${result.rerank_score.toFixed(2)}${result.rerank_score >= 1.5 ? " (high quality)" : ""}`);
	}
	if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`);

	const body =
		withContent && result.content && result.content.trim()
			? result.content.trim()
			: (result.summary ?? "").trim() || (result.snippet ?? "").trim();
	if (body) {
		if (charLength(body) > MAX_RESULT_CONTENT_CHARS) {
			const kept = Array.from(body).slice(0, MAX_RESULT_CONTENT_CHARS).join("");
			lines.push(kept.replace(/^/gm, "   "));
			lines.push(`   … content truncated (${charLength(body)} chars total)`);
		} else {
			lines.push(body.replace(/^/gm, "   "));
		}
	}
	return lines.join("\n");
}

/* ------------------------------------------------------------------- tools */

const SEARCH_SCHEMA = {
	type: "object",
	properties: {
		query: {
			type: "string",
			minLength: 1,
			description:
				'Search query. Supports operators: "exact phrase", -word, -"phrase", site:a.com OR site:b.com, -site:c.com, lang:en,zh, after:2025-01-01, before:2026-06-01.',
		},
		count: {
			type: "integer",
			minimum: 1,
			maximum: 50,
			description: "Results to return (default 10). Does not change the per-request price.",
		},
		ori_question: {
			type: "string",
			maxLength: MAX_ORI_QUESTION_CHARS,
			description:
				"The user's original question, verbatim. Improves query understanding and ranking; this ranking signal is unavailable through generic web-search wrappers.",
		},
		need_content: {
			type: "boolean",
			description:
				"Return the full extracted text of each page instead of a summary. Same price per request; costs more context.",
		},
		allowed_domains: {
			type: "array",
			items: { type: "string" },
			description: "Restrict results to these domains (becomes site: OR site:).",
		},
		blocked_domains: {
			type: "array",
			items: { type: "string" },
			description: "Exclude these domains (becomes -site:).",
		},
		lang: { type: "string", description: 'Language codes, e.g. "zh,en" (becomes lang:).' },
		recency: {
			type: "string",
			enum: ["day", "week", "month", "year"],
			description: "Published within this window (becomes after:<date>).",
		},
		localization: {
			type: "string",
			description: "Optional IP address used to localize results.",
		},
	},
	required: ["query"],
	additionalProperties: false,
} as const;

const FETCH_SCHEMA = {
	type: "object",
	properties: {
		url: { type: "string", description: "Absolute HTTP(S) URL to read as Markdown." },
		max_chars: {
			type: "integer",
			minimum: 500,
			maximum: 200_000,
			description: `Return at most this many characters (default ${MAX_FETCH_CONTENT_CHARS}).`,
		},
	},
	required: ["url"],
	additionalProperties: false,
} as const;

export default function (pi: any): void {
	pi.registerTool({
		name: "deepseek_search",
		label: "DeepSeek Search",
		description:
			"Search the live web with DeepSeek's own search engine (in-house index, reranked on relevance + authority + freshness). " +
			"Returns title, URL, site, publication date, authority tier (0-4) and rerank score, plus a model-oriented summary or, with need_content, the full page text. " +
			"Supports count (1-50), ori_question for ranking, domain/lang/date filters, and localization. " +
			"Prefer this over a generic web_search when you need publication dates or DeepSeek's ranking; reserve it for when precision matters, since each call is billed per request.",
		promptSnippet: "Search the web via DeepSeek's search engine (dates, authority, ori_question)",
		parameters: SEARCH_SCHEMA,
		async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
			const rawCount = Number(params.count ?? 10);
			const options: SearchOptions = {
				query: assertQueryText(String(params.query ?? "")),
				count: Math.min(50, Math.max(1, Number.isFinite(rawCount) ? Math.floor(rawCount) : 10)),
				need_content: params.need_content === true,
				allowedDomains: Array.isArray(params.allowed_domains) ? params.allowed_domains : [],
				blockedDomains: Array.isArray(params.blocked_domains) ? params.blocked_domains : [],
				...(typeof params.ori_question === "string" && params.ori_question.trim()
					? { ori_question: params.ori_question.trim().slice(0, MAX_ORI_QUESTION_CHARS) }
					: {}),
				...(typeof params.lang === "string" && params.lang.trim() ? { lang: params.lang.trim() } : {}),
				...(params.recency ? { recency: params.recency } : {}),
				...(typeof params.localization === "string" && params.localization.trim()
					? { localization: assertLocalization(params.localization) }
					: {}),
			};

			const apiKey = await resolveApiKey(ctx);
			const { query, dropped } = fitQuery(options);

			const body: Record<string, unknown> = { query, count: options.count };
			if (options.need_content) body.need_content = true;
			if (options.ori_question) body.ori_question = options.ori_question;
			if (options.localization) body.localization = options.localization;

			const data = await postDeepSeek<{ results?: DeepSeekResult[] }>(
				"/v1/tools/search",
				body,
				apiKey,
				signal,
				SEARCH_TIMEOUT_MS,
			);

			const results = (Array.isArray(data.results) ? data.results : []).filter(
				(entry) => typeof entry?.url === "string" && /^https?:\/\//i.test(entry.url),
			);

			const header: string[] = [
				`DeepSeek search · ${results.length} result${results.length === 1 ? "" : "s"}`,
			];
			header.push(`query: ${query}`);
			if (options.ori_question) header.push(`ori_question: ${options.ori_question}`);
			if (dropped.length > 0) header.push(`trimmed to fit 128 chars: ${dropped.join("; ")}`);

			const text =
				results.length === 0
					? `${header.join("\n")}\n\nNo results. Try a broader query, drop filters, or use a multi-provider search tool.`
					: `${header.join("\n")}\n\n${results
							.map((result, index) => formatResult(result, index, options.need_content))
							.join("\n\n")}`;

			return {
				content: [{ type: "text", text }],
				details: {
					query,
					dropped,
					count: results.length,
					needContent: options.need_content,
					estimatedCostUsd: results.length > 0 ? PRICE_PER_SUCCESSFUL_REQUEST_USD : 0,
					results: results.map((result) => ({
						title: result.title ?? "",
						url: result.url,
						site: result.site_name ?? null,
						date: result.date ?? null,
						authority: result.authority ?? null,
						score: result.rerank_score ?? null,
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: "deepseek_fetch",
		label: "DeepSeek Fetch",
		description:
			"Read one page through DeepSeek's Fetch API and get it back as Markdown (already extracted, rendered server-side). " +
			"Use after deepseek_search when a summary is not enough, or for a specific URL you already know.",
		promptSnippet: "Fetch a URL as Markdown via DeepSeek (server-side rendering + extraction)",
		parameters: FETCH_SCHEMA,
		async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
			const url = assertFetchableUrl(String(params.url ?? ""));
			const maxChars = Math.min(
				200_000,
				Math.max(500, Number(params.max_chars ?? MAX_FETCH_CONTENT_CHARS) || MAX_FETCH_CONTENT_CHARS),
			);
			const apiKey = await resolveApiKey(ctx);

			const data = await postDeepSeek<{ title?: string; content?: string }>(
				"/v1/tools/fetch",
				{ url: url.toString() },
				apiKey,
				signal,
				FETCH_TIMEOUT_MS,
			);

			const title = typeof data.title === "string" ? data.title.trim() : "";
			const content = typeof data.content === "string" ? cleanMarkdown(data.content).trim() : "";
			if (!content) {
				throw new Error(`DeepSeek Fetch returned no usable content for ${url.toString()}`);
			}

			const total = charLength(content);
			const body = total > maxChars ? Array.from(content).slice(0, maxChars).join("") : content;
			const text = [
				`DeepSeek fetch · ${total} chars${total > maxChars ? ` (truncated to ${maxChars})` : ""}`,
				title ? `title: ${title}` : "",
				url.toString(),
				"",
				body,
			]
				.filter((line) => line !== "")
				.join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					url: url.toString(),
					title,
					chars: total,
					truncated: total > maxChars,
					estimatedCostUsd: PRICE_PER_SUCCESSFUL_REQUEST_USD,
				},
			};
		},
	});
}
