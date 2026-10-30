# @dumbmice/pi-deepseek-websearch

[![npm version](https://img.shields.io/npm/v/@dumbmice/pi-deepseek-websearch)](https://www.npmjs.com/package/@dumbmice/pi-deepseek-websearch)
[![license](https://img.shields.io/npm/l/@dumbmice/pi-deepseek-websearch)](https://github.com/DumbMice/pi-deepseek-websearch/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@dumbmice/pi-deepseek-websearch)](https://github.com/DumbMice/pi-deepseek-websearch/blob/main/package.json)
[![tests](https://github.com/DumbMice/pi-deepseek-websearch/actions/workflows/test.yml/badge.svg)](https://github.com/DumbMice/pi-deepseek-websearch/actions/workflows/test.yml)

Two tools for the [pi coding agent](https://pi.dev), wrapping DeepSeek's Search and Fetch APIs.
`deepseek_search` returns ranked web results with a publication date, authority tier and rerank score
per hit, plus `ori_question` and `localization` for steering the ranking. `deepseek_fetch` returns a
page as Markdown.

## Example output

`deepseek_search` with `need_content: true` and `count: 2`, second result omitted:

```text
DeepSeek search · 2 results
query: DeepSeek V4 Pro release

1. DeepSeek-V4-Pro GA Release | DeepSeek API Docs
   https://api-docs.deepseek.com/news/news260813/
   DeepSeek · 2026-08-12 · authority 3/4 · score 2.58 (high quality)
   # DeepSeek-V4-Pro GA Release
   We're launching DeepSeek-V4-Pro today! …
```

## When to use it

- The answer depends on **when** something was published, or on an authoritative source — the results
  carry `date` and `authority` where a generic search returns bare snippets.
- The agent needs a **specific count**, from 1 to 50.
- The user's original question can ride along as `ori_question`, which improves ranking.
- The agent should read the page rather than the snippet: `need_content` returns extracted text, and
  `deepseek_fetch` reads a known URL.

## Install

```bash
# from npm
pi install npm:@dumbmice/pi-deepseek-websearch

# straight from the repository
pi install git:github.com/DumbMice/pi-deepseek-websearch
```

Requirements:

- Node >= 22.6.
- A DeepSeek key, from pi's `deepseek` provider (`/login`) or the `DEEPSEEK_API_KEY` variable. Create
  one at <https://platform.deepseek.com/api_keys>.
- Optional, for a compatible gateway: set `PI_DEEPSEEK_BASE_URL` or `DEEPSEEK_SEARCH_BASE_URL`. A
  trailing slash or `/v1` suffix is stripped. The bare `DEEPSEEK_BASE_URL` is ignored on purpose,
  because other tools point it at an OpenAI-compatible `/v1` root.

Confirm registration by starting `pi` and asking *"use deepseek_search to look up the DeepSeek API
pricing"*; the reply begins with a `DeepSeek search · N result(s)` header.

## Tools

### `deepseek_search`

| Parameter | Type | Notes |
|---|---|---|
| `query` | string, required | capped at 128 characters, operators included |
| `count` | integer 1–50 | default 10 |
| `ori_question` | string | the user's question, used for ranking; values over 128 characters are cut and the cut is reported |
| `need_content` | boolean | return extracted page text when available, otherwise the summary or snippet; 4,000 characters per result, truncation reported |
| `allowed_domains` | string[] | compiled to `site:` clauses; counts toward the 128-character cap |
| `blocked_domains` | string[] | compiled to `-site:` clauses; counts toward the cap |
| `lang` | string | e.g. `"zh,en"` becomes `lang:zh,en` |
| `recency` | `day` \| `week` \| `month` \| `year` | compiled to `after:<date>` |
| `localization` | string | optional IPv4 or IPv6 literal; results are localized to that address's region; country codes are rejected |

`query` accepts DeepSeek's operators unchanged: `"exact phrase"`, `-word`, `-"phrase"`,
`site:a.example OR site:b.example`, `-site:c.example`, `lang:en,zh`, `after:2025-01-01`,
`before:2026-06-01`.

Each result shows title, URL, site, date, authority tier (`0–4`; the API's `-1` appears as *authority
unknown*), rerank score (`≥1.5` marked high quality), and the summary or extracted text. Results
without an `http(s)` URL are discarded, and the reply reports how many.

`details` carries the same call in structured form: the final query, the requested and returned
counts, anything trimmed or discarded, one record per result, and the estimated cost.

### `deepseek_fetch`

| Parameter | Type | Notes |
|---|---|---|
| `url` | string, required | absolute public HTTP(S), at most 8192 characters, no credentials |
| `max_chars` | integer 500–200000 | default 20000; truncation and clamping are reported |

Returns the page as Markdown, extracted server-side. A page with no extractable content is reported as
an error, not as an empty success.

## Cost and limits

- $0.75 per 1,000 successful requests for both tools
  ([billing](https://api-docs.deepseek.com/guides/search#billing)). A search is billable only when the
  API returns HTTP 200 with a non-empty `results` array, and a fetch only when it returns page
  content, so failures, timeouts and empty searches cost nothing. `count` does not change the price.
- 100 QPS for Search, 25 QPS for Fetch per account, plus a per-domain Fetch limit
  ([rate limits](https://api-docs.deepseek.com/guides/search#rate-limits)).

## Behaviour to expect

- **Long queries are trimmed, not rejected.** The 128-character cap includes operators; when a query
  is shortened, the reply names what went — filters first, then trailing words, then a truncated tail
  — and prints the final query.
- **Transient failures are retried.** `408`, `429`, any `5xx`, network failures and timeouts get up
  to three attempts, honouring `retry-after` (seconds or an HTTP date) capped at 5 seconds. Every
  other `4xx` fails immediately with DeepSeek's own message. Each attempt has its own deadline: 30
  seconds for search, 60 for fetch.
- **A search with no matches is a normal answer**, not an error.
- **Private targets are refused.** `deepseek_fetch` will not fetch `localhost` or private address
  ranges. This is deliberate: DeepSeek fetches pages server-side, and the guard avoids handing it
  intranet URLs. It matches literal addresses only — no DNS lookup is performed.
- **The API key is redacted** from upstream error text and network-failure messages before they reach
  the model or the transcript.

## Troubleshooting

- **`deepseek_search` appears twice in the tool list.** Remove the older copy — for example a copy you
  placed directly in `~/.pi/agent/extensions/` — then `/reload`.
- **`DeepSeek API key not found`.** Create a key at <https://platform.deepseek.com/api_keys>,
  configure pi's `deepseek` provider with `/login`, or set `DEEPSEEK_API_KEY`.
- **The output says `trimmed to fit 128 chars`.** The request was shortened; shorten the query or drop
  filters to avoid it.

## Further reading

- **Deviations from DeepSeek's API** — every deliberate difference:
  [docs/docs-alignment.md](https://github.com/DumbMice/pi-deepseek-websearch/blob/main/docs/docs-alignment.md)
- **Working on this repository** — layout, tests, invariants, release process:
  [AGENTS.md](https://github.com/DumbMice/pi-deepseek-websearch/blob/main/AGENTS.md)
- **Changes by version**:
  [CHANGELOG.md](https://github.com/DumbMice/pi-deepseek-websearch/blob/main/CHANGELOG.md)

## License

MIT. Source and issues: <https://github.com/DumbMice/pi-deepseek-websearch>.
