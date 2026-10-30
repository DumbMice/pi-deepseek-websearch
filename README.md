# pi-deepseek-api

DeepSeek **Search** and **Fetch** API tools for the [pi coding agent](https://pi.dev) — direct access to the fields and parameters that generic web-search wrappers throw away.

Two tools, no dependencies, and it **coexists with `pi-web-access`** (different tool names, no config keys of its own).

```text
deepseek_search  "DeepSeek-V4-Pro GA Release | DeepSeek API Docs"
                 https://api-docs.deepseek.com/news/news260813/
                 DeepSeek · 2026-08-12 · authority 3/4 · score 2.58 (high quality)
                 # DeepSeek-V4-Pro GA Release
                 We're launching DeepSeek-V4-Pro today! …
```

## Why

`pi-web-access` maps DeepSeek's Search API onto its generic provider interface. That is the right shape for a 40-provider router, but it loses what makes DeepSeek's API useful:

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
pi install npm:pi-deepseek-api

# or straight from a repo / working copy
pi install git:github.com/<you>/pi-deepseek-api
pi install /absolute/path/to/pi-deepseek-api

# try it for one session
pi -e npm:pi-deepseek-api
```

> If you previously installed a single-file copy of this extension in `~/.pi/agent/extensions/`, remove it first — two copies would register `deepseek_search` twice.

## Credentials

The extension uses, in order:

1. pi's `deepseek` provider credentials (`ctx.modelRegistry.getApiKeyForProvider("deepseek")`) — i.e. `/login` or `auth.json`;
2. `DEEPSEEK_API_KEY`.

Endpoint override: `PI_DEEPSEEK_BASE_URL`, then `DEEPSEEK_SEARCH_BASE_URL` (default `https://api.deepseek.com`). The bare `DEEPSEEK_BASE_URL` is deliberately ignored: other tools commonly set it to an OpenAI-compatible `/v1` root.

Get a key at <https://platform.deepseek.com/api_keys>.

## Tools

### `deepseek_search`

| Parameter | Type | Notes |
|---|---|---|
| `query` | string, required | 1–128 Unicode chars. Operators pass through: `"exact phrase"`, `-word`, `-"phrase"`, `site:a OR site:b`, `-site:c`, `lang:en,zh`, `after:2025-01-01`, `before:2026-06-01` |
| `count` | integer 1–50 | default 10; the per-request price does not depend on it |
| `ori_question` | string ≤128 | your original question verbatim; improves query understanding and ranking |
| `need_content` | boolean | return full extracted page text instead of `summary`; same price, more context |
| `allowed_domains` | string[] | compiled to `site:` clauses joined with `OR` |
| `blocked_domains` | string[] | compiled to `-site:` clauses |
| `lang` | string | e.g. `"zh,en"` → `lang:zh,en` |
| `recency` | `day`\|`week`\|`month`\|`year` | compiled to `after:<date>` |
| `localization` | string | IP address used to localize results |

Results carry title, URL, site, publication date, authority tier (`0–4`, `-1` rendered as *unknown*), rerank score (`≥1.5` annotated as high quality), and either the model-oriented `summary` or the full text. `details.estimatedCostUsd` reports $0.00075 for a billed call and $0 for an empty result set.

### `deepseek_fetch`

| Parameter | Type | Notes |
|---|---|---|
| `url` | string, required | absolute HTTP(S), ≤8192 chars, no credentials |
| `max_chars` | integer 500–200000 | default 20000; truncation is reported with the true length |

Returns the page as Markdown, rendered and extracted server-side.

## Behaviour worth knowing

- **The 128-character limit is real** and counts `site:`, `lang:` and `after:` operators. Instead of failing, the extension sheds filters first (recency → language → domains), then trailing words, and prints `trimmed to fit 128 chars: …` so the request is never silently different from what you asked for.
- **Retries** cover `408`, `429`, `500`, `502`, `503`, `504` plus network failures and timeouts, up to 3 attempts, honouring `retry-after`. Documented non-retryable statuses (`400`, `401`, `402`, `403`, `404`, `413`) fail immediately with an actionable hint (top up, fix the key, security policy, no usable content, rate limits).
- **Billing**: `$0.75 per 1,000 successful requests` for both Search and Fetch. Failed calls, empty search results, and timeouts are not billed. `count` does not affect price.
- **Limits**: 100 QPS search, 25 QPS fetch per account, plus a per-domain fetch limit.
- **Empty is not an error**: a search with no matches returns a normal "No results" answer and costs nothing.

## Safety

- The API key is redacted from every error message before it reaches the model or the transcript.
- `deepseek_fetch` refuses `localhost`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `0/8`, `::1`, `fc00::/7` and `fe80::/10`. DeepSeek fetches pages server-side, so this is a policy choice about not handing intranet URLs to a third party — remove the guard if you need it to read internal docs.
- Markdown unescaping of Fetch output (DeepSeek escapes punctuation that was already plain text) never touches fenced blocks or inline code spans.

## Docs alignment

Validated against <https://api-docs.deepseek.com/guides/search>, `/api/search` and `/api/fetch` on **2026-10-30** (`DOCS_SNAPSHOT` in `src/index.ts`). Deliberate deviations, all visible in the tool output:

1. over-length queries are trimmed rather than rejected (and the trimming is reported);
2. `need_content` text is capped at 4,000 chars per result (context economy; the true length is printed);
3. `deepseek_fetch` blocks private addresses (docs impose no such rule);
4. Fetch Markdown is unescaped heuristically (docs only promise Markdown);
5. `date` is displayed as `YYYY-MM-DD` while the API returns RFC 3339 — the full timestamp stays in `details`;
6. network failures and timeouts are retried beyond the documented `408/429/5xx` list (they are unbilled).

If DeepSeek changes the API, bump `DOCS_SNAPSHOT` and update the affected tests.

## Development

```bash
npm test          # node:test, 28 tests, mocked HTTP — no API key or network needed
npm run pack:check
```

The suite covers query trimming order and the 128 cap, documented validation rules, metadata rendering (`authority: -1`, score annotation, summary/snippet/content precedence), retry classification per status, key redaction, URL safety, and both tool call shapes.

## License

MIT
