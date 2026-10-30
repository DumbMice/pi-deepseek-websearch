import assert from "node:assert/strict";
import test from "node:test";
import extension, {
	assertFetchableUrl,
	baseUrl,
	assertLocalization,
	assertQueryText,
	cleanMarkdown,
	errorHint,
	fitQuery,
	formatResult,
	MAX_QUERY_CHARS,
	PRICE_PER_SUCCESSFUL_REQUEST_USD,
	type SearchOptions,
} from "../src/index.ts";

const base = (over: Partial<SearchOptions> = {}): SearchOptions => ({
	query: "rust tokio select macro",
	count: 5,
	need_content: false,
	allowedDomains: [],
	blockedDomains: [],
	...over,
});

const chars = (value: string) => Array.from(value).length;

/* ------------------------------------------------------------------ fitQuery */

test("fitQuery: short query is unchanged", () => {
	const { query, dropped } = fitQuery(base());
	assert.equal(query, "rust tokio select macro");
	assert.deepEqual(dropped, []);
});

test("fitQuery: keeps filters when everything fits", () => {
	const { query, dropped } = fitQuery(
		base({ allowedDomains: ["a.example"], lang: "en", recency: "week" }),
	);
	assert.match(query, /^rust tokio select macro site:a\.example lang:en after:\d{4}-\d{2}-\d{2}$/);
	assert.deepEqual(dropped, []);
	assert.ok(chars(query) <= MAX_QUERY_CHARS);
});

test("fitQuery: sheds filters before words, and reports each removal", () => {
	const query =
		"what is the current recommended way to configure a long running daemon process with systemd socket activation and restart limits and logging and how do I debug failures";
	const { query: built, dropped } = fitQuery(
		base({
			query,
			allowedDomains: ["freedesktop.org", "archlinux.org"],
			blockedDomains: ["example.com"],
			lang: "en",
			recency: "year",
		}),
	);
	assert.ok(chars(built) <= MAX_QUERY_CHARS, `built query is ${chars(built)} chars`);
	const order = ["recency (", "language (", "domain filter (", "trailing query words"];
	const positions = order.map((prefix) => dropped.findIndex((d) => d.startsWith(prefix) || d === prefix));
	assert.ok(positions.every((position) => position >= 0), `missing drop: ${JSON.stringify(dropped)}`);
	assert.deepEqual([...positions].sort((a, b) => a - b), positions, "drops must follow recency → language → domains → words");
	// The surviving text keeps the original word order and never gains new words.
	assert.ok(query.startsWith(built.split(" site:")[0]!.slice(0, 40)));
});

test("fitQuery: filters never push a fitting query over the limit", () => {
	const { query, dropped } = fitQuery(
		base({ query: "x ".repeat(60).trim(), allowedDomains: ["a.example"] }),
	);
	assert.ok(chars(query) <= MAX_QUERY_CHARS);
	assert.ok(dropped.length > 0);
});

/* --------------------------------------------------------------- validation */

test("assertQueryText: rejects blank input, trims valid input", () => {
	assert.throws(() => assertQueryText(""), /must not be empty/);
	assert.throws(() => assertQueryText("   \t\n"), /must not be empty/);
	assert.equal(assertQueryText("  ok  "), "ok");
});

test("assertLocalization: accepts IP literals only", () => {
	assert.equal(assertLocalization("8.8.8.8"), "8.8.8.8");
	assert.equal(assertLocalization(" 1.1.1.1 "), "1.1.1.1");
	assert.throws(() => assertLocalization("not-an-ip"), /must be an IP address/);
});

test("assertFetchableUrl: follows the documented URL rules", () => {
	assert.equal(assertFetchableUrl("https://example.com/a?b=1").hostname, "example.com");
	assert.equal(assertFetchableUrl("http://example.com").protocol, "http:");
	assert.throws(() => assertFetchableUrl("ftp://example.com"), /http or https/);
	assert.throws(() => assertFetchableUrl("https://user:pw@example.com"), /credentials/);
	assert.throws(() => assertFetchableUrl("not a url"), /valid HTTP\(S\) URL/);
	assert.throws(() => assertFetchableUrl(`https://example.com/${"a".repeat(8200)}`), /8192 characters/);
});

test("assertFetchableUrl: refuses local and private targets", () => {
	for (const host of [
		"localhost",
		"app.localhost",
		"127.0.0.1",
		"10.1.2.3",
		"192.168.0.1",
		"172.16.5.4",
		"172.31.255.1",
		"169.254.169.254",
		"0.0.0.0",
	]) {
		assert.throws(() => assertFetchableUrl(`http://${host}/`), /local or private/, host);
	}
	assert.throws(() => assertFetchableUrl("http://[::1]/"), /local or private/);
	assert.throws(() => assertFetchableUrl("http://[fd00::1]/"), /local or private/);
	assert.throws(() => assertFetchableUrl("http://[fe80::1]/"), /local or private/);
	// Public addresses in the same numeric neighbourhoods stay allowed.
	assert.ok(assertFetchableUrl("http://172.32.0.1/"));
	assert.ok(assertFetchableUrl("http://11.0.0.1/"));
});

/* ---------------------------------------------------------------- rendering */

test("formatResult: authority -1 means unknown, and score >= 1.5 is annotated", () => {
	const text = formatResult(
		{
			title: "A",
			url: "https://ex.com/a",
			summary: "sum",
			authority: -1,
			rerank_score: 2.06,
			date: "2026-10-29T04:00:00+00:00",
			site_name: "Ex",
		},
		0,
		true,
	);
	const meta = text.split("\n")[2]!;
	assert.match(meta, /Ex · 2026-10-29 · authority unknown · score 2\.06 \(high quality\)/);
});

test("formatResult: prefers summary, falls back to snippet, uses content only when asked", () => {
	const result = { title: "T", url: "https://ex.com", summary: "SUM", snippet: "SNIP", content: "FULL" };
	assert.match(formatResult(result, 0, false), /SUM/);
	assert.doesNotMatch(formatResult(result, 0, false), /FULL/);
	assert.match(formatResult({ ...result, summary: "" }, 0, false), /SNIP/);
	assert.match(formatResult(result, 0, true), /FULL/);
});

test("formatResult: long content is truncated with the true length reported", () => {
	const text = formatResult({ title: "T", url: "https://ex.com", content: "x".repeat(5000) }, 0, true);
	assert.match(text, /content truncated \(5000 chars total\)/);
	assert.ok(text.length < 5000);
});

test("formatResult: missing title and metadata degrade cleanly", () => {
	const text = formatResult({ url: "https://ex.com/z" }, 3, false);
	assert.match(text, /^4\. \(untitled\)\n {3}https:\/\/ex\.com\/z$/);
});

test("cleanMarkdown: unescapes prose, preserves code", () => {
	assert.equal(cleanMarkdown("a\\.b 1\\.5"), "a.b 1.5");
	assert.equal(cleanMarkdown("use `a\\.b` here"), "use `a\\.b` here");
	assert.equal(cleanMarkdown("```\ncode\\.x\n```"), "```\ncode\\.x\n```");
});

test("errorHint: documents the status-specific remedy", () => {
	assert.match(errorHint(401, "/v1/tools/search"), /API key/);
	assert.match(errorHint(402, "/v1/tools/search"), /top up/);
	assert.match(errorHint(403, "/v1/tools/fetch"), /security policy/);
	assert.match(errorHint(404, "/v1/tools/fetch"), /no usable page content/);
	assert.match(errorHint(429, "/v1/tools/search"), /QPS/);
	assert.equal(errorHint(400, "/v1/tools/search"), "");
});

/* --------------------------------------------------------------- execution */

function harness() {
	const tools = new Map<string, any>();
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool) });
	const ctx = { modelRegistry: { getApiKeyForProvider: async () => "sk-test-key-1234567890" } };
	return { search: tools.get("deepseek_search"), fetch: tools.get("deepseek_fetch"), ctx };
}

function stubFetch(handler: (url: string, init: any, call: number) => Response | Promise<Response>) {
	const original = globalThis.fetch;
	const calls: Array<{ url: string; body: any }> = [];
	globalThis.fetch = (async (url: any, init: any) => {
		calls.push({ url: String(url), body: JSON.parse(init.body) });
		return handler(String(url), init, calls.length);
	}) as any;
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("deepseek_search: forwards count, ori_question, need_content and localization", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ results: [] }));
	try {
		await search.execute("t", {
			query: "  gpu benchmark  ",
			count: 7,
			ori_question: "which gpu is fastest?",
			need_content: true,
			localization: "8.8.8.8",
		}, undefined, undefined, ctx);
		const body = stub.calls[0]!.body;
		assert.equal(stub.calls[0]!.url, "https://api.deepseek.com/v1/tools/search");
		assert.deepEqual(body, {
			query: "gpu benchmark",
			count: 7,
			need_content: true,
			ori_question: "which gpu is fastest?",
			localization: "8.8.8.8",
		});
	} finally {
		stub.restore();
	}
});

test("deepseek_search: count is defaulted and clamped to 1-50", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ results: [] }));
	try {
		await search.execute("t", { query: "a" }, undefined, undefined, ctx);
		assert.equal(stub.calls[0]!.body.count, 10);
		await search.execute("t", { query: "a", count: 500 }, undefined, undefined, ctx);
		assert.equal(stub.calls[1]!.body.count, 50);
		await search.execute("t", { query: "a", count: 0 }, undefined, undefined, ctx);
		assert.equal(stub.calls[2]!.body.count, 1);
	} finally {
		stub.restore();
	}
});

test("deepseek_search: zero results is a normal answer, not an error, and costs nothing", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ results: [] }));
	try {
		const result = await search.execute("t", { query: "nothing matches" }, undefined, undefined, ctx);
		assert.match(result.content[0].text, /No results/);
		assert.equal(result.details.estimatedCostUsd, 0);
	} finally {
		stub.restore();
	}
});

test("deepseek_search: results without an http(s) url are dropped", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() =>
		json({
			results: [
				{ title: "ftp", url: "ftp://ex.com/a" },
				{ title: "ok", url: "https://ex.com/b", authority: 2, rerank_score: 1.1 },
			],
		}),
	);
	try {
		const result = await search.execute("t", { query: "q" }, undefined, undefined, ctx);
		assert.equal(result.details.count, 1);
		assert.equal(result.details.results[0].title, "ok");
	} finally {
		stub.restore();
	}
});

test("deepseek_search: retries 429 and honours retry-after: 0", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch((_url, _init, call) =>
		call < 3
			? json({ error: { message: "rate limited" } }, 429, { "retry-after": "0" })
			: json({ results: [{ title: "ok", url: "https://ex.com/a" }] }),
	);
	try {
		const result = await search.execute("t", { query: "q" }, undefined, undefined, ctx);
		assert.equal(stub.calls.length, 3);
		assert.equal(result.details.count, 1);
	} finally {
		stub.restore();
	}
});

test("deepseek_search: does not retry documented non-retryable statuses", async () => {
	for (const status of [400, 401, 402, 403, 404, 413]) {
		const { search, ctx } = harness();
		const stub = stubFetch(() => json({ error: { message: "nope" } }, status));
		try {
			await assert.rejects(
				() => search.execute("t", { query: "q" }, undefined, undefined, ctx),
				(e: Error) => (e as any).status === status,
			);
			assert.equal(stub.calls.length, 1, `status ${status} must not be retried`);
		} finally {
			stub.restore();
		}
	}
});

test("deepseek_search: retries transient failures and gives up after three attempts", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ error: { message: "boom" } }, 503, { "retry-after": "0" }));
	try {
		await assert.rejects(() => search.execute("t", { query: "q" }, undefined, undefined, ctx), /HTTP 503/);
		assert.equal(stub.calls.length, 3);
	} finally {
		stub.restore();
	}
});

test("deepseek_search: the api key is redacted from upstream error text", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ error: { message: "bad key sk-test-key-1234567890" } }, 400));
	try {
		await assert.rejects(
			() => search.execute("t", { query: "q" }, undefined, undefined, ctx),
			(e: Error) => !e.message.includes("sk-test-key-1234567890") && e.message.includes("[redacted]"),
		);
	} finally {
		stub.restore();
	}
});

test("deepseek_search: rejects invalid parameters before any request", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ results: [] }));
	try {
		await assert.rejects(() => search.execute("t", { query: "  " }, undefined, undefined, ctx), /must not be empty/);
		await assert.rejects(
			() => search.execute("t", { query: "q", localization: "nope" }, undefined, undefined, ctx),
			/must be an IP address/,
		);
		assert.equal(stub.calls.length, 0);
	} finally {
		stub.restore();
	}
});

test("deepseek_search: missing credentials produce a guided error", async () => {
	const { search } = harness();
	const original = process.env.DEEPSEEK_API_KEY;
	delete process.env.DEEPSEEK_API_KEY;
	try {
		await assert.rejects(
			() => search.execute("t", { query: "q" }, undefined, undefined, { modelRegistry: {} }),
			/API key not found/,
		);
	} finally {
		if (original !== undefined) process.env.DEEPSEEK_API_KEY = original;
	}
});

test("deepseek_fetch: returns markdown with truncation metadata", async () => {
	const { fetch, ctx } = harness();
	const stub = stubFetch(() => json({ title: "Doc", content: "line\\.one\n\nbody" }));
	try {
		const result = await fetch.execute("t", { url: "https://ex.com/doc", max_chars: 500 }, undefined, undefined, ctx);
		assert.equal(result.details.title, "Doc");
		assert.match(result.content[0].text, /line\.one/);
		assert.match(result.content[0].text, /DeepSeek fetch · 14 chars/);
		assert.equal(stub.calls[0]!.body.url, "https://ex.com/doc");
		assert.equal(result.details.estimatedCostUsd, PRICE_PER_SUCCESSFUL_REQUEST_USD);
	} finally {
		stub.restore();
	}
});

test("deepseek_fetch: empty page content is an error, not an empty success", async () => {
	const { fetch, ctx } = harness();
	const stub = stubFetch(() => json({ title: "", content: "   " }));
	try {
		await assert.rejects(
			() => fetch.execute("t", { url: "https://ex.com/doc" }, undefined, undefined, ctx),
			/no usable content/,
		);
	} finally {
		stub.restore();
	}
});

test("deepseek_fetch: refuses private urls before any request", async () => {
	const { fetch, ctx } = harness();
	const stub = stubFetch(() => json({ content: "x" }));
	try {
		await assert.rejects(
			() => fetch.execute("t", { url: "http://127.0.0.1:8080/" }, undefined, undefined, ctx),
			/local or private/,
		);
		assert.equal(stub.calls.length, 0);
	} finally {
		stub.restore();
	}
});

test("deepseek_fetch: surfaces the documented 403 security-policy hint", async () => {
	const { fetch, ctx } = harness();
	const stub = stubFetch(() => json({ error: { message: "blocked" } }, 403));
	try {
		await assert.rejects(
			() => fetch.execute("t", { url: "https://ex.com/doc" }, undefined, undefined, ctx),
			/security policy/,
		);
	} finally {
		stub.restore();
	}
});

/* ------------------------------------------- regression tests for review fixes */

test("assertFetchableUrl: trailing dots and IPv4-mapped IPv6 cannot bypass the guard", () => {
	for (const url of [
		"http://localhost./x",
		"http://app.localhost./x",
		"http://[::ffff:127.0.0.1]/x",
		"http://[::ffff:10.1.2.3]/x",
		"http://[::ffff:7f00:1]/x",
		"http://[::ffff:a9fe:a9fe]/x",
		"http://[::127.0.0.1]/x",
		"http://[::]/x",
		"http://[fc00::1]/x",
		"http://[fe80::1]/x",
		"http://100.64.1.1/x",
		"http://198.18.0.1/x",
		"http://127.1/x",
		"http://2130706433/x",
		"http://0x7f.1/x",
	]) {
		assert.throws(() => assertFetchableUrl(url), /local or private/, url);
	}
	// Same encodings for public addresses must still pass.
	assert.equal(assertFetchableUrl("http://[::ffff:8.8.8.8]/x").protocol, "http:");
	assert.equal(assertFetchableUrl("http://172.32.0.1/x").hostname, "172.32.0.1");
	assert.equal(assertFetchableUrl("http://100.128.0.1/x").hostname, "100.128.0.1");
});

test("fitQuery: an unknown recency is a clear error, not a RangeError", () => {
	assert.throws(
		() =>
			fitQuery({
				...base(),
				recency: "yesterday" as any,
			}),
		/recency must be one of day, week, month, year/,
	);
});

test("formatResult: non-string fields degrade instead of throwing", () => {
	const result = {
		url: "https://ex.com/a",
		title: 123 as any,
		date: 20261030 as any,
		summary: { text: "x" } as any,
		snippet: [] as any,
		authority: "3" as any,
		rerank_score: Number.NaN,
	};
	const text = formatResult(result, 0, false);
	assert.match(text, /^1\. \(untitled\)/);
	assert.equal(text.split("\n").length, 2, "only title and url lines survive");
});

test("cleanMarkdown: fences indented inside list items are protected", () => {
	assert.equal(
		cleanMarkdown("* item\n\n    ```\n    code\\.x\n    ```\n"),
		"* item\n\n    ```\n    code\\.x\n    ```\n",
	);
	assert.equal(cleanMarkdown("\t~~~\n\tcode\\.x\n\t~~~\n"), "\t~~~\n\tcode\\.x\n\t~~~\n");
});

test("fitQuery: caller spacing is preserved when the query fits", () => {
	const { query, dropped } = fitQuery(base({ query: "a   b\tc" }));
	assert.equal(query, "a   b\tc");
	assert.deepEqual(dropped, []);
});

test("deepseek_search: ori_question is cut by code point, never mid surrogate pair", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ results: [] }));
	try {
		await search.execute("t", { query: "q", ori_question: "a" + "\u{1F600}".repeat(200) }, undefined, undefined, ctx);
		const sent = stub.calls[0]!.body.ori_question as string;
		assert.ok(Array.from(sent).length <= 128, `ori_question is ${Array.from(sent).length} code points`);
		assert.doesNotMatch(sent, /[\uD800-\uDBFF]$/, "must not end on a lone high surrogate");
	} finally {
		stub.restore();
	}
});

test("deepseek_search: every documented 5xx is retried, not a closed subset", async () => {
	for (const status of [408, 429, 500, 501, 502, 503, 504, 505]) {
		const { search, ctx } = harness();
		const stub = stubFetch((_url, _init, call) =>
			call === 1 ? json({ error: { message: "later" } }, status, { "retry-after": "0" }) : json({ results: [] }),
		);
		try {
			await search.execute("t", { query: "q" }, undefined, undefined, ctx);
			assert.equal(stub.calls.length, 2, `HTTP ${status} must be retried`);
		} finally {
			stub.restore();
		}
	}
});

test("deepseek_search: undocumented 425 is not retried", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ error: { message: "too early" } }, 425));
	try {
		await assert.rejects(() => search.execute("t", { query: "q" }, undefined, undefined, ctx), /HTTP 425/);
		assert.equal(stub.calls.length, 1);
	} finally {
		stub.restore();
	}
});

test("deepseek_search: cost follows the raw result array, not client-side filtering", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() =>
		json({ results: [{ title: "a", url: "ftp://ex.com/a" }, { title: "b", url: "mailto:x@y.z" }] }),
	);
	try {
		const result = await search.execute("t", { query: "q" }, undefined, undefined, ctx);
		assert.equal(result.details.count, 0);
		assert.equal(result.details.discarded, 2);
		assert.equal(result.details.estimatedCostUsd, PRICE_PER_SUCCESSFUL_REQUEST_USD);
		assert.match(result.content[0].text, /discarded 2 unusable results \(no http\(s\) URL\)/);
	} finally {
		stub.restore();
	}
});

test("deepseek_search: site_icon is surfaced in details", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() =>
		json({ results: [{ title: "a", url: "https://ex.com", site_icon: "https://ex.com/f.ico" }] }),
	);
	try {
		const result = await search.execute("t", { query: "q" }, undefined, undefined, ctx);
		assert.equal(result.details.results[0].siteIcon, "https://ex.com/f.ico");
	} finally {
		stub.restore();
	}
});

test("deepseek_search: non-string domain entries are dropped, not stringified into the query", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ results: [] }));
	try {
		await search.execute(
			"t",
			{ query: "q", allowed_domains: [" ok.example ", 42, {}, null] },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(stub.calls[0]!.body.query, "q site:ok.example");
	} finally {
		stub.restore();
	}
});

test("baseUrl: PI_DEEPSEEK_BASE_URL wins and /v1 plus trailing slashes are stripped", () => {
	const original = { ...process.env };
	try {
		process.env.PI_DEEPSEEK_BASE_URL = "https://gateway.example.com/ds/v1/";
		process.env.DEEPSEEK_SEARCH_BASE_URL = "https://ignored.example.com";
		assert.equal(baseUrl(), "https://gateway.example.com/ds");
		delete process.env.PI_DEEPSEEK_BASE_URL;
		assert.equal(baseUrl(), "https://ignored.example.com");
		delete process.env.DEEPSEEK_SEARCH_BASE_URL;
		process.env.DEEPSEEK_BASE_URL = "https://must-be-ignored.example.com";
		assert.equal(baseUrl(), "https://api.deepseek.com");
	} finally {
		for (const key of ["PI_DEEPSEEK_BASE_URL", "DEEPSEEK_SEARCH_BASE_URL", "DEEPSEEK_BASE_URL"]) {
			if (original[key] === undefined) delete process.env[key];
			else process.env[key] = original[key];
		}
	}
});

test("deepseek_search: an HTTP-date retry-after is honoured", async () => {
	const { search, ctx } = harness();
	const started = Date.now();
	const stub = stubFetch((_url, _init, call) =>
		call === 1
			? json({ error: { message: "slow down" } }, 429, {
					"retry-after": new Date(Date.now() - 30_000).toUTCString(),
				})
			: json({ results: [] }),
	);
	try {
		await search.execute("t", { query: "q" }, undefined, undefined, ctx);
		assert.equal(stub.calls.length, 2);
		assert.ok(Date.now() - started < 2_000, "a past HTTP-date must not stall");
	} finally {
		stub.restore();
	}
});

test("deepseek_search: a 200 with a non-JSON body is a clear, non-retried error", async () => {
	const { search, ctx } = harness();
	let calls = 0;
	const original = globalThis.fetch;
	globalThis.fetch = (async () => {
		calls++;
		return new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } });
	}) as any;
	try {
		await assert.rejects(
			() => search.execute("t", { query: "q" }, undefined, undefined, ctx),
			/returned invalid JSON/,
		);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = original;
	}
});

test("deepseek_search: network failures are retried, then surface the failure", async () => {
	const { search, ctx } = harness();
	let calls = 0;
	const original = globalThis.fetch;
	globalThis.fetch = (async () => {
		calls++;
		throw new TypeError("fetch failed");
	}) as any;
	try {
		await assert.rejects(
			() => search.execute("t", { query: "q" }, undefined, undefined, ctx),
			/request failed: fetch failed/,
		);
		assert.equal(calls, 3);
	} finally {
		globalThis.fetch = original;
	}
});

test("deepseek_search: an already-aborted signal makes no request", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ results: [] }));
	try {
		await assert.rejects(
			() => search.execute("t", { query: "q" }, AbortSignal.abort(), undefined, ctx),
			(e: Error) => e.name === "AbortError" || /abort/i.test(e.message),
		);
		assert.equal(stub.calls.length, 0);
	} finally {
		stub.restore();
	}
});

test("deepseek_fetch: a clamped max_chars is reported", async () => {
	const { fetch, ctx } = harness();
	const stub = stubFetch(() => json({ title: "t", content: "abc" }));
	try {
		const result = await fetch.execute("t", { url: "https://ex.com/d", max_chars: 10 }, undefined, undefined, ctx);
		assert.equal(result.details.maxChars, 500);
		assert.match(result.content[0].text, /max_chars clamped to 500/);
	} finally {
		stub.restore();
	}
});

/* --------------------------------------- round-2 review regressions and gaps */

test("fitQuery: trimming never leaves a dangling operator", () => {
	const { query, dropped } = fitQuery({
		...base(),
		query: "a ".repeat(60).trim() + " site: example.com",
	});
	assert.ok(!/(?:^|\s)(?:-|-?[a-z]+:)$/i.test(query), `dangling operator in ${JSON.stringify(query)}`);
	assert.ok(query.length <= MAX_QUERY_CHARS);
	assert.ok(dropped.includes("trailing query words"));
});

test("fitQuery: quoted phrases are atomic, so trimming cannot unbalance quotes", () => {
	const { query } = fitQuery({ ...base(), query: "word ".repeat(25) + '"alpha beta gamma"' });
	assert.equal((query.match(/"/g) ?? []).length % 2, 0, `unbalanced quotes in ${JSON.stringify(query)}`);
	assert.ok(!query.includes('"alpha beta') || query.includes('"alpha beta gamma"'));
});

test("fitQuery: a single tab that gets rewritten is reported", () => {
	const { query, dropped } = fitQuery({ ...base(), query: "a\tb " + "c ".repeat(70).trim() });
	assert.ok(!query.includes("\t"));
	assert.ok(dropped.includes("query whitespace normalised"), JSON.stringify(dropped));
});

test("fitQuery: exactly 128 chars is left alone; 129 is trimmed", () => {
	assert.deepEqual(fitQuery({ ...base(), query: "x".repeat(128) }).dropped, []);
	assert.deepEqual(fitQuery({ ...base(), query: "x".repeat(128) }).query, "x".repeat(128));
	const over = fitQuery({ ...base(), query: "x".repeat(129) });
	assert.equal(Array.from(over.query).length, 128);
	assert.ok(over.dropped.includes("query tail"));
});

test("assertFetchableUrl: bare hex-pair IPv6 and NAT64 forms of loopback are blocked; public hosts are not", () => {
	for (const url of ["http://[::7f00:1]/x", "http://[::ffff:0:1]/x", "http://[64:ff9b::7f00:1]/x"]) {
		assert.throws(() => assertFetchableUrl(url), /local or private/, url);
	}
	for (const url of [
		"http://example.com./x",
		"http://notlocalhost.example/x",
		"http://[2001:db8::1]/x",
		"http://[::abcd:1234]/x",
	]) {
		assert.ok(assertFetchableUrl(url), url);
	}
});

test("deepseek_search: a cut ori_question is reported in the output and details", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ results: [] }));
	try {
		const result = await search.execute(
			"t",
			{ query: "q", ori_question: "a" + "\u{1F600}".repeat(200) },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.details.oriQuestionTruncated, true);
		assert.match(result.content[0].text, /ori_question: .* \(cut to 128 chars\)/);
	} finally {
		stub.restore();
	}
});

test("deepseek_search: a non-array domain filter is rejected instead of silently ignored", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ results: [] }));
	try {
		await assert.rejects(
			() => search.execute("t", { query: "q", allowed_domains: "example.com" }, undefined, undefined, ctx),
			/allowed_domains must be an array/,
		);
		assert.equal(stub.calls.length, 0);
	} finally {
		stub.restore();
	}
});

test("deepseek_search: parameter validation runs before the credential lookup", async () => {
	const { search } = harness();
	const original = process.env.DEEPSEEK_API_KEY;
	delete process.env.DEEPSEEK_API_KEY;
	try {
		await assert.rejects(
			() =>
				search.execute(
					"t",
					{ query: "q", recency: "yesterday" },
					undefined,
					undefined,
					{ modelRegistry: {} },
				),
			/recency must be one of/,
		);
	} finally {
		if (original !== undefined) process.env.DEEPSEEK_API_KEY = original;
	}
});

test("deepseek_search: non-finite scores are omitted from details rather than serialised", async () => {
	const { search, ctx } = harness();
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response('{"results":[{"title":"t","url":"https://ex.com","authority":1e999,"rerank_score":1e999}]}', {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as any;
	try {
		const result = await search.execute("t", { query: "q" }, undefined, undefined, ctx);
		assert.equal(result.details.results[0].authority, null);
		assert.equal(result.details.results[0].score, null);
		assert.doesNotThrow(() => JSON.stringify(result.details));
	} finally {
		globalThis.fetch = original;
	}
});

test("deepseek_search: null and scalar results are counted as discarded, not rendered", async () => {
	const { search, ctx } = harness();
	const stub = stubFetch(() => json({ results: [null, 42, { title: "ok", url: "https://ex.com" }] }));
	try {
		const result = await search.execute("t", { query: "q" }, undefined, undefined, ctx);
		assert.equal(result.details.count, 1);
		assert.equal(result.details.discarded, 2);
		assert.equal(result.details.requestedCount, 10);
	} finally {
		stub.restore();
	}
});
