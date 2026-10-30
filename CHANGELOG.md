# Changelog

## 0.1.0 — 2026-10-30

First release.

**Tools**

- `deepseek_search` and `deepseek_fetch` over `POST /v1/tools/search` and `POST /v1/tools/fetch`.
- Search parameters: `count` 1–50, `ori_question`, `need_content`, `localization`, `allowed_domains`, `blocked_domains`, `lang`, `recency`.
- Fetch parameters: `url`, `max_chars` (500–200,000, default 20,000).
- Result metadata: `date`, `authority` (`-1` → *unknown*), `rerank_score` (≥1.5 annotated), `site_name`; `site_icon` available in `details`.
- `details` reports the final query, anything trimmed, discarded non-http(s) results, and `estimatedCostUsd`.

**Query handling**

- A fitting query is sent exactly as written, spacing included.
- An over-length query is trimmed instead of rejected: recency → language → domain filters → trailing words, with a final code-point cut only if a single token exceeds the budget. Every removal is reported.
- Unknown `recency` values and non-IP `localization` values are rejected with an actionable message.

**Transport**

- Retries for `408`, `429`, any `5xx`, network failures and timeouts; 3 attempts; `retry-after` honoured in seconds or HTTP-date form, capped at 5 s.
- Documented remedies for `401`/`402`/`403`/`404`/`413`/`429`; all other `4xx` fail immediately.
- 30 s search / 60 s fetch timeouts; caller abort wins and makes no request when already aborted.
- Endpoint override via `PI_DEEPSEEK_BASE_URL` or `DEEPSEEK_SEARCH_BASE_URL`, with `/v1` and trailing slashes stripped.
- API key from pi's `deepseek` provider, then `DEEPSEEK_API_KEY`; redacted from all error output.

**Safety**

- `deepseek_fetch` refuses localhost (including trailing-dot forms), IPv4 private/loopback/CGNAT/link-local/benchmarking ranges, IPv6 `::`, `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped IPv6 forms.
- Markdown unescaping never applies inside fenced code blocks (including indented fences) or inline code spans.
- Malformed result fields degrade instead of failing the whole call.

**Cost and compatibility**

- `estimatedCostUsd` = $0.00075 per billable request, following the raw result array so client-side filtering cannot under-report; 0 for an empty result set.
- Coexists with `pi-web-access`: distinct tool names, no config keys.
- Validated against DeepSeek API docs as of 2026-10-30.

**Tests**

- 45 `node:test` cases with mocked HTTP — no key or network required.
