# @dumbmice/pi-deepseek-websearch

[![npm version](https://img.shields.io/npm/v/@dumbmice/pi-deepseek-websearch)](https://www.npmjs.com/package/@dumbmice/pi-deepseek-websearch)
[![license](https://img.shields.io/npm/l/@dumbmice/pi-deepseek-websearch)](LICENSE)
[![node](https://img.shields.io/node/v/@dumbmice/pi-deepseek-websearch)](package.json)
[![tests](https://github.com/DumbMice/pi-deepseek-websearch/actions/workflows/test.yml/badge.svg)](https://github.com/DumbMice/pi-deepseek-websearch/actions/workflows/test.yml)
[![coexists with pi-web-access](https://img.shields.io/badge/coexists%20with-pi--web--access-2ea44f)](#why)

DeepSeek **Search** and **Fetch** API tools for the [pi coding agent](https://pi.dev) — direct access to the fields and parameters that generic web-search wrappers throw away.

Two tools, no dependencies, and it **coexists with `pi-web-access`**: different tool names, no web-search.json keys of its own, no settings to migrate.

```text
DeepSeek search · 2 results     ← abridged
query: DeepSeek V4 Pro release

1. DeepSeek-V4-Pro GA Release | DeepSeek API Docs
   https://api-docs.deepseek.com/news/news260813/
   DeepSeek · 2026-08-12 · authority 3/4 · score 2.58 (high quality)
   # DeepSeek-V4-Pro GA Release
   We're launching DeepSeek-V4-Pro today! …
```

Every result also carries site, publication date, authority tier and rerank score; `details` holds the full set.

## Why

`pi-web-access` maps DeepSeek's Search API onto its generic provider interface (compared against `pi-web-access@0.44.0`, verified 2026-10-30). That is the right shape for a 40-provider router, but it loses what makes DeepSeek's API useful:

| | `pi-web-access` DeepSeek provider | this extension |
|---|---|---|
| `date`, `authority`, `rerank_score` | dropped | rendered per result |
| `ori_question` (ranking hint) | never sent | `ori_question` param |
| `localization` | never sent | `localization` param |
| `count` | hidden, clamped to 20 | `count` param, 1–50 |
| query > 128 chars | hard error, no fallback | trimmed, with the removals reported |
| 429 / 5xx | no retry | 3 attempts honouring `retry-after` |
| `need_content` | only via a generic flag | `need_content` param |

Use it when you need DeepSeek's ranking, publication dates, or a specific `count`. Keep `pi-web-access` for routing across providers, `fetch_content`'s extraction chain, and `source_check`.

## Install

```bash
# from npm
pi install npm:@dumbmice/pi-deepseek-websearch

# straight from GitHub
pi install git:github.com/DumbMice/pi-deepseek-websearch

# from a working copy (no publish required)
pi install /absolute/path/to/pi-deepseek-websearch

# try it for one session
pi -e /absolute/path/to/pi-deepseek-websearch
```

Requires Node >= 22.6 (`engines`; the shipped entry point is TypeScript).

If you previously installed a single-file copy of this extension in `~/.pi/agent/extensions/`, remove it first — two copies would register `deepseek_search` twice. `pi-web-access` itself needs no change.

Confirm it registered: start `pi`, ask *"use deepseek_search to look up the DeepSeek API pricing"*, and you should see a `DeepSeek search · N results` header. Or check the tool list in your session.

## Credentials

The extension uses, in order:

1. pi's `deepseek` provider credentials (`ctx.modelRegistry.getApiKeyForProvider("deepseek")`) — i.e. `/login` or `auth.json`;
2. `DEEPSEEK_API_KEY`.

Endpoint override: `PI_DEEPSEEK_BASE_URL`, then `DEEPSEEK_SEARCH_BASE_URL` (default `https://api.deepseek.com`; a trailing slash or `/v1` suffix is stripped). The bare `DEEPSEEK_BASE_URL` is deliberately ignored: other tools commonly set it to an OpenAI-compatible `/v1` root.

Get a key at <https://platform.deepseek.com/api_keys>.

## Tools

### `deepseek_search`

| Parameter | Type | Notes |
|---|---|---|
| `query` | string, required | Operators pass through: `"exact phrase"`, `-word`, `-"phrase"`, `site:a OR site:b`, `-site:c`, `lang:en,zh`, `after:2025-01-01`, `before:2026-06-01`. Capped at 128 chars; longer queries are trimmed (see below) rather than rejected |
| `count` | integer 1–50 | default 10; the per-request price does not depend on it |
| `ori_question` | string (cut to 128) | your original question, used for ranking; a longer value is cut to 128 code points and the cut is reported in the output |
| `need_content` | boolean | return extracted page text when the API provides it (otherwise the `summary`, or the `snippet` if there is no summary), capped at 4,000 chars per result with truncation reported; same price, more context |
| `allowed_domains` | string[] | compiled to `site:` clauses joined with `OR`; counts toward the 128-char cap |
| `blocked_domains` | string[] | compiled to `-site:` clauses; counts toward the cap |
| `lang` | string | e.g. `"zh,en"` → `lang:zh,en` |
| `recency` | `day`\|`week`\|`month`\|`year` | compiled to `after:<date>` |
| `localization` | string | IPv4/IPv6 literal used to localize results; anything else is rejected |

Each result carries title, URL, site, publication date, authority tier (`0–4`; the API's `-1` renders as *authority unknown*), and rerank score (`≥1.5` annotated as high quality), plus the model-oriented `summary` or the extracted page text. `site_icon` is not rendered but is included in `details`.

`details` also reports: the final `query`, `dropped` (anything trimmed), `count` (results returned), `requestedCount`, `discarded` (unusable results, e.g. no `http(s)` URL), `oriQuestionTruncated`, `needContent`, the mapped `results[]`, and `estimatedCostUsd`.

### `deepseek_fetch`

| Parameter | Type | Notes |
|---|---|---|
| `url` | string, required | absolute public HTTP(S), ≤8192 chars, no credentials; local/private targets are refused |
| `max_chars` | integer 500–200000 | default 20000; truncation and clamping are both reported |

Returns the page as Markdown, rendered and extracted server-side. A page with no extractable content is an error rather than an empty success. `details` reports `url`, `title`, `chars`, `maxChars`, `truncated` and `estimatedCostUsd`.

## Behaviour worth knowing

- **The 128-character limit is real** and includes `site:`, `lang:` and `after:` operators. When the query fits, it is sent exactly as written, spacing included. Only an over-long query is rewritten, and then filters are shed first (recency → language → domains), then trailing words, then — only if a single token exceeds the whole budget — the tail is cut. Every trimming removal is printed as `trimmed to fit 128 chars: …`, so the query itself is never silently shortened. Trimming is token-aware: quoted phrases stay whole, and a trailing operator (`site:`, `after:`, a bare `-`) is dropped rather than left dangling.
- **Retries** cover `408`, `429` and **any** `5xx` — the documented "wait and retry" set — plus network failures and timeouts, up to 3 attempts. `retry-after` is honoured in seconds or HTTP-date form, capped at 5 s. Every other `4xx` fails immediately.
- **Hints** accompany `401` (key), `402` (top up), `403`/`404` on Fetch (security policy, no usable content), `413` (body too large) and `429` (rate limits); `400` surfaces the API's own message.
- **Billing**: $0.75 per 1,000 successful requests for both Search and Fetch (<https://api-docs.deepseek.com/guides/search#billing>). A request is billable when it returns HTTP 200 **and** a non-empty result, so `estimatedCostUsd` follows the raw result array even if every URL is later discarded. Failed calls, empty search results and timeouts are reported as free, because no HTTP 200 is observed for them. `count` does not affect price.
- The docs' note that server-side tool calls are free until 2026-11-01 00:00 Beijing time is scoped to DeepSeek Harness / Claude Code / Codex usage; this extension calls the API directly, so the published per-request price applies.
- **Limits**: 100 QPS search, 25 QPS fetch per account, plus a per-domain fetch limit (<https://api-docs.deepseek.com/guides/search#rate-limits>).
- **Empty is not an error**: a search with no matches returns a normal "No results" answer and costs nothing.

## Safety

- The API key is redacted from every error message before it reaches the model or the transcript.
- `deepseek_fetch` refuses `localhost` and `*.localhost` (including trailing-dot forms), IPv4 loopback/private/CGNAT/link-local/benchmarking ranges, `::`, `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped IPv6 forms such as `::ffff:127.0.0.1`.
- This is a **policy** choice, not a docs requirement: DeepSeek fetches pages server-side, so the guard exists to avoid handing intranet URLs to a third party. It matches literal addresses and localhost names only — a public hostname that resolves to a private address is not caught, because no DNS lookup is performed.
- Markdown unescaping of Fetch output (DeepSeek escapes punctuation that was already plain text) never touches fenced blocks — including fences indented inside list items — or inline code spans.

## Docs alignment

Validated against <https://api-docs.deepseek.com/guides/search>, `/api/search` and `/api/fetch` on **2026-10-30** (`DOCS_SNAPSHOT` in `src/index.ts`). The wire contract is followed exactly where the docs define it: endpoints, auth headers, request fields and defaults, response field semantics, price, QPS and the documented error taxonomy.

Client-side deviations and transport details, listed in full. Items producing no signal in the output are marked _(silent)_.

1. over-length queries are trimmed rather than rejected, and every removal is reported; a single token longer than the whole budget is cut mid-token;
2. query whitespace is normalised only when the query must be rewritten, and that is reported in the same line;
3. leading/trailing whitespace is stripped from `query`, `ori_question` and `localization` before use _(silent — the API rejects all-whitespace queries anyway)_;
4. result body text (extracted content, else `summary`, else `snippet`) is capped at 4,000 chars per result; the true length is printed;
5. `count` is clamped to 1–50 instead of the API returning 400 — the schema declares the range too, and clamping is the fallback if a host passes values through unvalidated; `details.requestedCount` still shows the original ask;
6. results without an `http(s)` URL are discarded defensively — the count is reported and the price still reflects the raw response;
7. `site_icon` is surfaced in `details` but not rendered;
8. `ori_question` longer than 128 code points is cut, and the cut is reported in the output and `details`;
9. `deepseek_fetch` blocks local/private addresses (docs impose no such rule);
10. Fetch Markdown is unescaped heuristically (docs only promise Markdown) _(silent; never inside code)_;
11. `max_chars` truncates Fetch output and clamps out-of-range values (again, the schema declares the range), both reported;
12. a 200 response with empty Fetch content is treated as an error (docs route empty extraction to 404);
13. `date` is displayed as `YYYY-MM-DD` while the API returns RFC 3339 — the full timestamp stays in `details`;
14. the Fetch `url` is sent in its normalised form (`URL.toString()`: IDN punycoding, lowercased host, added `/`), and the 8192-char limit is checked against both the raw and the normalised form;
15. redirects of the API request itself are not followed (`redirect: "error"` on the call to `api.deepseek.com`), so a 3xx from the API surfaces as a fetch error and is retried like a network failure (item 16). Target-page redirects are DeepSeek's concern, not this client's _(silent)_;
16. network failures and timeouts are retried beyond the documented `408/429/5xx` list (they are unbilled) _(silent)_;
17. `retry-after` support is an inference — the docs never mention the header — and the delay is capped at 5 s _(silent)_;
18. the 128- and 8192-character limits are counted in code points. The docs say "1 to 128 Unicode characters" for `query` and "characters" elsewhere, without fixing code points vs UTF-16 units _(silent)_;
19. client request timeouts are 30 s (search) and 60 s (fetch) **per attempt**, so a call that keeps timing out can run ~90 s (search) or ~180 s (fetch) plus backoff before the third attempt fails; the docs describe no response deadline _(silent)_;
20. a 200 search body without a `results` array is rejected as an invalid response instead of being reported as "No results";
21. `localization` must be an IP literal — the docs only say "an optional IP address", so a country code is rejected client-side;
22. upstream error messages are sliced to 400 characters before display _(silent)_;
23. result fields of an unexpected type are ignored rather than passed through, so one malformed result degrades instead of failing the call _(silent)_;
24. `recency` windows are fixed client-side at 1 / 7 / 30 / 365 days for `day` / `week` / `month` / `year`.

Transport details, for completeness: requests send `Accept: application/json` alongside the two documented headers; retry backoff is 500 ms then 1 s when no `retry-after` is present (two sleeps for three attempts); and a 200 response with a non-JSON body fails immediately without a retry.

If DeepSeek changes the API, bump `DOCS_SNAPSHOT` and update the affected tests.

## Development

Requires Node >= 22.6 (the test runner uses `--experimental-strip-types`).

```bash
npm test              # node:test, 68 tests, mocked HTTP — no API key or network needed
npm run typecheck     # tsc --noEmit, strict
npm run pack:check    # tarball contents (no tests, no devDependencies)
```

The suite covers query trimming order and the 128 cap, caller-spacing preservation, documented validation rules, metadata rendering (`authority: -1`, score annotation, summary/snippet/content precedence, malformed fields), retry classification for every documented status, key redaction, URL safety including encoding bypasses, abort handling, and both tool call shapes.

## Releasing

Versions are published from CI with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers):
the workflow exchanges a GitHub OIDC token for a short-lived publish credential, so the repository
holds **no `NPM_TOKEN` secret** and no long-lived write credential (including a 2FA-bypass token)
is needed or permitted. Because the repository is public, npm attaches a **provenance attestation**
automatically — no `--provenance` flag.

```bash
npm version patch --no-git-tag-version   # or minor/major
git commit -am "chore: release v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push origin main --follow-tags        # .github/workflows/publish.yml runs test + typecheck, then publishes
```

`.github/workflows/publish.yml` runs the 68 tests and the typecheck, and refuses to publish when the
pushed tag and `package.json` version disagree, so a mis-versioned tag fails the build instead of
shipping the wrong number. For maximum safety the package's *Publishing access* can then be set to
"Require two-factor authentication and disallow tokens": trusted publishing keeps working, token
publishing stops.

## License

MIT. Issues and source: <https://github.com/DumbMice/pi-deepseek-websearch>.
