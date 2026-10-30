# DeepSeek API alignment

How this extension's behaviour relates to DeepSeek's published Search & Fetch API contract,
validated against <https://api-docs.deepseek.com/guides/search>, `/api/search` and `/api/fetch`
on **2026-10-30** (`DOCS_SNAPSHOT` in `src/index.ts`).

The wire contract is followed where the docs define it: endpoints, auth headers, request fields and
defaults, response field semantics, price, QPS, and the documented error taxonomy. A request this
extension can emit is always a valid request.

Client-side deviations and transport details, listed in full. Items that produce no signal in the
output are marked _(silent)_; everything else is observable in the reply or in `details`.

1. over-length queries are trimmed rather than rejected, and every removal is reported; a single
   token longer than the whole budget is cut mid-token;
2. query whitespace is normalised only when the query must be rewritten, and that is reported in the
   same line;
3. leading and trailing whitespace is stripped from `query`, `ori_question` and `localization` before
   use _(silent — for `query` the API rejects an all-whitespace value; the other two are trimmed for
   hygiene)_;
4. result body text is the extracted `content` when `need_content` is set, otherwise the `summary`,
   else the `snippet`; the rendered text is capped at 4,000 chars per result and the true length is
   printed;
5. `count` is clamped to 1–50 instead of the API returning 400 — the schema declares the range too,
   and clamping is the fallback if a host passes values through unvalidated; `details.requestedCount`
   still shows the caller's numeric ask (floored; a non-numeric or non-finite ask is reported as 10);
6. results without an `http(s)` URL are discarded defensively — the count is reported and the price
   still reflects the raw response;
7. `site_icon` is surfaced as `siteIcon` in `details` but not rendered;
8. `ori_question` longer than 128 code points is cut, and the cut is reported in the output and
   `details`;
9. `deepseek_fetch` blocks local and private addresses (the docs impose no such rule). IPv6 forms
   beyond `::ffff:`, `::/96` and NAT64 `64:ff9b::/96` — 6to4 and RFC 8215 — are out of scope;
10. Fetch Markdown is unescaped heuristically (the docs only promise Markdown) _(silent; never inside
    code)_;
11. `max_chars` truncates Fetch output and clamps out-of-range values (again, the schema declares the
    range), both reported;
12. a 200 response with empty Fetch content is treated as an error (the docs route empty extraction to
    404);
13. `date` is displayed as `YYYY-MM-DD` while the API returns RFC 3339 — the full timestamp stays in
    `details`;
14. the Fetch `url` is sent in its normalised form (`URL.toString()`: IDN punycoding, lowercased host,
    added `/`), and the 8192-character limit is checked against both the raw and the normalised form;
15. redirects of the API request itself are not followed (`redirect: "error"` on the call to
    `api.deepseek.com`), so a 3xx from the API surfaces as a fetch error and is retried like a network
    failure (item 16); target-page redirects are DeepSeek's concern, not this client's. The failure
    message names the redirect rather than the redirect target _(silent)_;
16. network failures and timeouts are retried beyond the documented `408`/`429`/`5xx` list (they are
    unbilled) _(silent)_;
17. `retry-after` support is an inference — the docs never mention the header — and the delay is
    capped at 5 s _(silent)_;
18. the 128- and 8192-character limits are counted in code points. The docs say "1 to 128 Unicode
    characters" for `query` and "characters" elsewhere, without fixing code points versus UTF-16
    units _(silent)_;
19. client request timeouts are 30 s (search) and 60 s (fetch) **per attempt**, so a call that keeps
    timing out can run ~90 s (search) or ~180 s (fetch) plus backoff before the third attempt fails;
    the docs describe no response deadline. The duration appears in the failure message;
20. a 200 search body without a `results` array is rejected as an invalid response instead of being
    reported as "No results";
21. `localization` must be an IP literal — the docs only say "an optional IP address", so a country
    code is rejected client-side;
22. upstream error messages are sliced to 400 characters before display _(silent)_;
23. result fields of an unexpected type are ignored rather than passed through, so one malformed
    result degrades instead of failing the call _(silent)_;
24. `recency` windows are fixed client-side at 1 / 7 / 30 / 365 days for `day` / `week` / `month` /
    `year`.

Transport details: requests send `Accept: application/json` alongside the two documented headers;
retry backoff is 500 ms then 1 s when no `retry-after` is present (two sleeps for three attempts); and
a 200 response with a non-JSON body fails immediately without a retry.

## Maintaining this list

Most items are pinned by a test in `test/index.test.ts`. The exceptions are transport-only details
asserted by inspection — the per-attempt timeout values (item 19) and the `recency` day counts
(item 24, pinned only as an `after:<date>` clause).

Changing a documented behaviour means changing its item here, the matching README text and the test in
the same commit. `DOCS_SNAPSHOT` lives in `src/index.ts` (header comment and constant) and at the
top of this file — keep them in step. When DeepSeek revises the API, bump
that date and re-audit every item.
