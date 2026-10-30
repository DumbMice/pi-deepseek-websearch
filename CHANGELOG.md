# Changelog

## 0.1.0 — 2026-10-30

First release.

- `deepseek_search` and `deepseek_fetch` tools over `POST /v1/tools/search` and `POST /v1/tools/fetch`.
- Full result metadata: `date`, `authority` (`-1` → unknown), `rerank_score` (≥1.5 annotated), `site_name`.
- Parameters: `count` 1–50, `ori_question`, `need_content`, `localization`, `allowed_domains`, `blocked_domains`, `lang`, `recency`.
- Over-length queries are trimmed (recency → language → domains → trailing words) and the removals are reported.
- Retries for 408/429/5xx and network failures with `retry-after`, 3 attempts; documented per-status hints for everything else.
- API key from pi's `deepseek` provider or `DEEPSEEK_API_KEY`; redacted from error output.
- `deepseek_fetch` refuses local/private targets and never unescapes inside code fences.
- Validated against DeepSeek API docs as of 2026-10-30.
