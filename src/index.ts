/**
 * @dumbmice/pi-deepseek-websearch — web search and page fetch over DeepSeek's Search & Fetch APIs.
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
	site_icon?: string | null;
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

const RECENCY_DAYS: Record<NonNullable<SearchOptions["recency"]>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

const REDACT = (text: string, key: string | undefined): string =>
	key && key.length > 8 ? text.split(key).join("[redacted]") : text;

const charLength = (value: string): number => Array.from(value).length;

export function baseUrl(): string {
	const configured =
		process.env.PI_DEEPSEEK_BASE_URL ?? process.env.DEEPSEEK_SEARCH_BASE_URL ?? DEFAULT_BASE_URL;
	return configured.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function resolveApiKey(ctx: any): Promise<string> {
	let fromPi: unknown;
	try {
		fromPi = await ctx?.modelRegistry?.getApiKeyForProvider?.("deepseek");
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`Could not read pi's \`deepseek\` provider credentials: ${reason}`);
	}
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
	if (status === 413)
		return path === "/v1/tools/fetch"
			? "\nHint: the request body was too large; shorten the URL."
			: "\nHint: the request body was too large; shorten the query.";
	if (status === 429)
		return "\nHint: rate limit (100 QPS search / 25 QPS fetch account-wide, plus a per-domain fetch limit). Retry after a pause.";
	return "";
}

/**
 * Docs: "For HTTP 408, 429, or 5xx errors, wait and retry." Every other status fails fast
 * ("Do not retry other 4xx errors without changing the request.").
 */
function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(response: Response, attempt: number): number {
	const RETRY_CAP_MS = 5_000;
	const header = response.headers.get("retry-after");
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_CAP_MS);
		const at = Date.parse(header);
		if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), RETRY_CAP_MS);
	}
	return 500 * 2 ** attempt;
}

/** Preserve the caller's abort reason; hosts use it to tell cancellation from failure. */
function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError(signal));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal!));
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
	if (signal?.aborted) throw abortError(signal);
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
			if (signal?.aborted) throw abortError(signal);
			const failure =
				timeout.aborted
					? new Error(`DeepSeek ${path} timed out after ${Math.round(timeoutMs / 1000)}s`)
					: new Error(
							`DeepSeek ${path} request failed: ${REDACT(err instanceof Error ? err.message : String(err), apiKey)}`,
						);
			if (attempt < MAX_ATTEMPTS - 1) {
				await sleep(500 * 2 ** attempt, signal);
				continue;
			}
			throw failure;
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
		if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS - 1) {
			await sleep(retryDelayMs(response, attempt), signal);
			continue;
		}
		throw error;
	}
	throw new Error(`DeepSeek ${path} failed`);
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
		const days = RECENCY_DAYS[options.recency];
		if (days === undefined) {
			throw new Error(`recency must be one of ${Object.keys(RECENCY_DAYS).join(", ")}.`);
		}
		filters.push(`after:${new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)}`);
	}

	const raw = options.query.trim();
	const join = (words: string[], activeFilters: string[]): string =>
		[words.join(" "), ...activeFilters].filter(Boolean).join(" ");

	// Docs: "The query is forwarded with its search syntax intact." Keep the caller's
	// spacing and operator text whenever the assembled query already fits.
	const untouched = [raw, ...filters].filter(Boolean).join(" ");
	if (charLength(untouched) <= MAX_QUERY_CHARS) return { query: untouched, dropped };

	// Only a query that cannot fit is rewritten, token by token, and every change is reported.
	// An unescaped quoted phrase is one token: slicing mid-phrase would change its meaning.
	// Backslash-escaped quotes are not special-cased (only reachable on over-length queries).
	const matchedTokens = raw.match(/"[^"]*"|\S+/g);
	const tokens: string[] = matchedTokens ? [...matchedTokens] : [raw];
	const quotesWereBalanced = ((raw.match(/"/g) ?? []).length % 2) === 0;
	if (raw !== tokens.join(" ")) dropped.push("query whitespace normalised");
	let words = tokens;
	let active = [...filters];

	const overBudget = () => charLength(join(words, active)) > MAX_QUERY_CHARS;
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
	// Never leave a dangling operator (`site:`, `-site:`, `after:`, a bare `-`) or an
	// unbalanced quote behind: DeepSeek would answer 400 and no retry would help.
	const danglingOperator = /^(?:-|-[A-Za-z]+:|[A-Za-z]+:)$/;
	const quoteCount = () => (words.join(" ").match(/"/g) ?? []).length;
	while (
		words.length > 1 &&
		(danglingOperator.test(words[words.length - 1]!) || (quotesWereBalanced && quoteCount() % 2 === 1))
	) {
		words = words.slice(0, -1);
	}
	if (words.join(" ") !== wordsBefore && !dropped.includes("trailing query words")) {
		dropped.push("trailing query words");
	}

	let query = join(words, active);
	if (charLength(query) > MAX_QUERY_CHARS) {
		// A single token longer than the whole budget: cutting it is unavoidable, so do it
		// by code point and report it rather than sending an invalid request.
		query = Array.from(query).slice(0, MAX_QUERY_CHARS).join("").trim();
		// A cut can land on a bare operator (`-`, `:`), which the API would reject.
		while (query.length > 0 && /[-:]$/.test(query)) query = Array.from(query).slice(0, -1).join("").trimEnd();
		if (quotesWereBalanced && (query.match(/"/g) ?? []).length % 2 === 1) {
			// The cut left one unmatched quote: remove that quote rather than invent a pair.
			const balanced = Array.from(query);
			const lastQuote = balanced.lastIndexOf('"');
			if (lastQuote >= 0) balanced.splice(lastQuote, 1);
			query = balanced.join("").trimEnd();
		}
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

/**
 * Normalise a WHATWG hostname: drop IPv6 brackets, case, and trailing dots
 * (`localhost.` and `localhost` are the same host to a resolver).
 */
function normalizeHost(hostname: string): string {
	return hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

/** `::ffff:127.0.0.1`, `::ffff:7f00:1`, `::7f00:1` and NAT64 `64:ff9b::7f00:1` all mean 127.0.0.1. */
function embeddedIpv4(host: string): string | null {
	const tail = host.match(/^(?:64:ff9b::|::ffff:|::)(.+)$/)?.[1];
	if (!tail) return null;
	if (tail.includes(".")) return tail;
	const groups = tail.split(":");
	if (groups.length !== 2) return null;
	const hi = Number.parseInt(groups[0]!, 16);
	const lo = Number.parseInt(groups[1]!, 16);
	if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
	return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

/** RFC 1918, loopback, link-local, CGNAT, "this network" and benchmarking ranges. */
function isPrivateIpv4(ip: string): boolean {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4) return false;
	if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts as [number, number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19))
	);
}

function isPrivateHost(hostname: string): boolean {
	const host = normalizeHost(hostname);
	const candidate = embeddedIpv4(host) ?? host;
	if (candidate === "localhost" || candidate.endsWith(".localhost")) return true;
	if (isIP(candidate) === 4) return isPrivateIpv4(candidate);
	if (isIP(candidate) === 6) {
		if (candidate === "::" || candidate === "::1") return true;
		if (/^f[cd][0-9a-f]{0,2}::?/.test(candidate)) return true; // fc00::/7 unique-local
		if (/^fe[89ab][0-9a-f]?::?/.test(candidate)) return true; // fe80::/10 link-local
	}
	return false;
}

/** Docs: http(s), a host, no credentials, at most 8192 characters. */
export function assertFetchableUrl(raw: string): URL {
	if (charLength(raw) > 8192) throw new Error("url must be at most 8192 characters.");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("url must be a valid HTTP(S) URL with a host.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must use http or https.");
	if (url.username || url.password) throw new Error("url must not contain credentials.");
	// The request sends the normalised form, so the limit must hold for that form too
	// (IDN punycoding can make it longer than what the caller passed).
	if (charLength(url.toString()) > 8192) throw new Error("url must be at most 8192 characters.");

	// Extra safety beyond the docs: DeepSeek fetches server-side, so refuse to hand it
	// intranet targets. Only literal local/private addresses and localhost names are
	// caught here; a public hostname that resolves privately is not (no DNS lookup).
	if (isPrivateHost(url.hostname)) throw new Error("url must not target a local or private address.");
	return url;
}

/** DeepSeek Fetch over-escapes punctuation that was already plain text. */
export function cleanMarkdown(markdown: string): string {
	let fence: { char: string; length: number } | null = null;
	return markdown
		.split("\n")
		.map((line) => {
			const marker = line.match(/^(\s*)(`{3,}|~{3,})/);
			if (marker) {
				const token = marker[2]!;
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
	// Response fields are trusted to exist but not to have the documented type: a single
	// malformed result must degrade, not destroy the whole answer.
	const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
	const lines: string[] = [];
	lines.push(`${index + 1}. ${text(result.title) || "(untitled)"}`);
	lines.push(`   ${text(result.url)}`);

	const meta: string[] = [];
	const siteName = text(result.site_name);
	if (siteName) meta.push(siteName);
	const date = text(result.date);
	if (date) meta.push(date.slice(0, 10));
	if (typeof result.authority === "number" && Number.isFinite(result.authority)) {
		// Docs: 0-4, where -1 means the tier is unknown.
		meta.push(result.authority < 0 ? "authority unknown" : `authority ${result.authority}/4`);
	}
	if (typeof result.rerank_score === "number" && Number.isFinite(result.rerank_score)) {
		meta.push(`score ${result.rerank_score.toFixed(2)}${result.rerank_score >= 1.5 ? " (high quality)" : ""}`);
	}
	if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`);

	const content = typeof result.content === "string" ? result.content.trim() : "";
	const summary = typeof result.summary === "string" ? result.summary.trim() : "";
	const snippet = typeof result.snippet === "string" ? result.snippet.trim() : "";
	const body = withContent && content ? content : summary || snippet;
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
				'Search query. Supports operators: "exact phrase", -word, -"phrase", site:a.com OR site:b.com, -site:c.com, lang:en,zh, after:2025-01-01, before:2026-06-01. Queries are capped at 128 chars including operators; anything longer is trimmed automatically (filters shed first, then trailing words) and the removals are reported in the output — do not pre-shorten.',
		},
		count: {
			type: "integer",
			minimum: 1,
			maximum: 50,
			description: "Results to return (default 10). Does not change the per-request price.",
		},
		ori_question: {
			type: "string",
			description:
				"The user's original question. Improves query understanding and ranking; pass it as-is even if the query is a shortened form. Values over 128 characters are cut and the cut is reported; this ranking signal is unavailable through generic web-search wrappers.",
		},
		need_content: {
			type: "boolean",
			description:
				"Return extracted page text when the API provides it (falls back to the summary, then the snippet) — up to 4,000 chars per result, with any truncation reported. Same price per request; uses more context.",
		},
		allowed_domains: {
			type: "array",
			items: { type: "string" },
			description:
				"Restrict results to these domains (compiled into site: OR site:). Counts toward the 128-char query cap, so a long domain list can be dropped for very long queries — any drop is reported in the output.",
		},
		blocked_domains: {
			type: "array",
			items: { type: "string" },
			description:
				"Exclude these domains (compiled into -site:). Counts toward the 128-char query cap and may be dropped for very long queries; any drop is reported.",
		},
		lang: { type: "string", description: 'Language codes, e.g. "zh,en" (becomes lang:).' },
		recency: {
			type: "string",
			enum: ["day", "week", "month", "year"],
			description: "Published within this window (becomes after:<date>).",
		},
		localization: {
			type: "string",
			description: "Optional IPv4/IPv6 literal used to localize results (e.g. 203.0.113.7); country codes are rejected.",
		},
	},
	required: ["query"],
	additionalProperties: false,
} as const;

const FETCH_SCHEMA = {
	type: "object",
	properties: {
		url: {
			type: "string",
			description:
				"Absolute public HTTP(S) URL (≤8192 chars) with no embedded credentials, read as Markdown. Local and private addresses are refused.",
		},
		max_chars: {
			type: "integer",
			minimum: 500,
			maximum: 200_000,
			description: `Return at most this many characters (default ${MAX_FETCH_CONTENT_CHARS}). Values outside 500-200000 are clamped, and the clamp is reported in the output.`,
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
			"Search the live web with DeepSeek's search engine (in-house index, reranked on relevance + authority + freshness). " +
			"Returns title, URL, site, publication date, authority tier (0-4, or 'unknown') and rerank score, plus a model-oriented summary or, with need_content, extracted page text. " +
			"Supports count (1-50), ori_question for ranking, domain/lang/date filters, and localization. " +
			"Choose this instead of a generic web_search when the answer depends on when something was published, you need authoritative sources, you want 21-50 results, or you can pass the user's original question as ori_question. " +
			"Search is billed per successful request ($0.00075); a query that returns nothing costs nothing.",
		promptSnippet: "Search the web via DeepSeek's search engine (dates, authority, ori_question)",
		parameters: SEARCH_SCHEMA,
		async execute(
			_toolCallId: string,
			params: any = {},
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: any,
		) {
			const rawCount = Number(params.count ?? 10);
			const requestedCount = Number.isFinite(rawCount) ? Math.floor(rawCount) : 10;
			const domains = (value: unknown, label: string): string[] => {
				if (value === undefined || value === null) return [];
				if (!Array.isArray(value)) throw new Error(`${label} must be an array of domain names.`);
				return value
					.filter((entry): entry is string => typeof entry === "string")
					.map((entry) => entry.trim())
					.filter(Boolean);
			};
			const oriChars = Array.from(
				typeof params.ori_question === "string" ? params.ori_question.trim() : "",
			);
			const oriQuestion = oriChars.length > 0 ? oriChars.slice(0, MAX_ORI_QUESTION_CHARS).join("") : undefined;
			const oriQuestionTruncated = oriChars.length > MAX_ORI_QUESTION_CHARS;
			const options: SearchOptions = {
				query: assertQueryText(String(params.query ?? "")),
				count: Math.min(50, Math.max(1, requestedCount)),
				need_content: params.need_content === true,
				allowedDomains: domains(params.allowed_domains, "allowed_domains"),
				blockedDomains: domains(params.blocked_domains, "blocked_domains"),
				...(oriQuestion ? { ori_question: oriQuestion } : {}),
				...(typeof params.lang === "string" && params.lang.trim() ? { lang: params.lang.trim() } : {}),
				...(params.recency ? { recency: params.recency } : {}),
				...(typeof params.localization === "string" && params.localization.trim()
					? { localization: assertLocalization(params.localization) }
					: {}),
			};

			// Validate and trim first: a bad parameter should not be masked by a missing key.
			const { query, dropped } = fitQuery(options);
			const apiKey = await resolveApiKey(ctx);

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

			// Docs: billable when the request returns HTTP 200 *and* a non-empty results
			// array — so cost follows the raw array, not what survives client-side filtering.
			// A 200 without a results array is a broken response, not an empty result set.
			if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
				throw new Error("DeepSeek /v1/tools/search returned an invalid response: expected a results array");
			}
			const rawResults = (data as { results: DeepSeekResult[] }).results;
			const results = rawResults.filter(
				(entry) => typeof entry?.url === "string" && /^https?:\/\//i.test(entry.url),
			);
			const discarded = rawResults.length - results.length;

			const header: string[] = [
				`DeepSeek search · ${results.length} result${results.length === 1 ? "" : "s"}`,
			];
			header.push(`query: ${query}`);
			if (options.ori_question) {
				header.push(
					`ori_question: ${options.ori_question}${oriQuestionTruncated ? ` (cut to ${MAX_ORI_QUESTION_CHARS} chars)` : ""}`,
				);
			}
			if (dropped.length > 0)
				header.push(`trimmed to fit ${MAX_QUERY_CHARS} chars: ${dropped.join("; ")}`);
			if (discarded > 0)
				header.push(`discarded ${discarded} unusable result${discarded === 1 ? "" : "s"} (no http(s) URL)`);

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
					requestedCount,
					discarded,
					oriQuestionTruncated,
					needContent: options.need_content,
					estimatedCostUsd: rawResults.length > 0 ? PRICE_PER_SUCCESSFUL_REQUEST_USD : 0,
					results: results.map((result) => ({
						title: typeof result.title === "string" ? result.title : "",
						url: result.url,
						site: typeof result.site_name === "string" ? result.site_name : null,
						siteIcon: typeof result.site_icon === "string" ? result.site_icon : null,
						date: typeof result.date === "string" ? result.date : null,
						authority:
							typeof result.authority === "number" && Number.isFinite(result.authority)
								? result.authority
								: null,
						score:
							typeof result.rerank_score === "number" && Number.isFinite(result.rerank_score)
								? result.rerank_score
								: null,
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
			"Use after deepseek_search when a summary is not enough, or for a specific URL you already know. " +
			"Billed the same $0.00075 per successful fetch; failures and empty extractions are free.",
		promptSnippet: "Fetch a URL as Markdown via DeepSeek (server-side rendering + extraction)",
		parameters: FETCH_SCHEMA,
		async execute(
			_toolCallId: string,
			params: any = {},
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: any,
		) {
			const url = assertFetchableUrl(String(params.url ?? ""));
			const requestedChars = Number(params.max_chars ?? MAX_FETCH_CONTENT_CHARS);
			const requested = Number.isFinite(requestedChars) ? Math.floor(requestedChars) : MAX_FETCH_CONTENT_CHARS;
			const maxChars = Math.min(200_000, Math.max(500, requested));
			const clamped = maxChars !== requested;
			const apiKey = await resolveApiKey(ctx);

			const data = await postDeepSeek<{ title?: unknown; content?: unknown }>(
				"/v1/tools/fetch",
				{ url: url.toString() },
				apiKey,
				signal,
				FETCH_TIMEOUT_MS,
			);

			const title = typeof data?.title === "string" ? data.title.trim() : "";
			const content = typeof data?.content === "string" ? cleanMarkdown(data.content).trim() : "";
			if (!content) {
				throw new Error(`DeepSeek Fetch returned no usable content for ${url.toString()}`);
			}

			const total = charLength(content);
			const body = total > maxChars ? Array.from(content).slice(0, maxChars).join("") : content;
			const text = [
				`DeepSeek fetch · ${total} chars${total > maxChars ? ` (truncated to ${maxChars})` : ""}${clamped ? ` (max_chars clamped to ${maxChars})` : ""}`,
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
					maxChars,
					truncated: total > maxChars,
					estimatedCostUsd: PRICE_PER_SUCCESSFUL_REQUEST_USD,
				},
			};
		},
	});
}
