# Changelog

All notable changes to this extension are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.4] - 2026-10-30

### Added

- Test coverage for previously unpinned behaviour: the API request is sent with `redirect: "error"` so
  a redirect is not followed (register item 15), upstream error text is sliced to 400 characters
  (register item 22), Fetch output truncation and the `max_chars` upper clamp, the `retry-after` delay
  and its 5 second cap, and rejection of domain filters that would rewrite the query structure.

### Changed

- Documentation overhaul. The README is now strictly for users of the extension: what the tools do,
  when to use them, parameters, cost, observable behaviour and troubleshooting. The list of deliberate
  differences from DeepSeek's API moved to `docs/docs-alignment.md`. Contributor, architecture and
  release material moved to `AGENTS.md` (`CONTRIBUTING.md` now points there), including the corrected
  release recipe with annotated tags. This changelog moved to the Keep a Changelog format.
- Package metadata: the npm description and keywords were rewritten, `files` now also ships `docs/`,
  `AGENTS.md` and `CONTRIBUTING.md` so the deviation register and contributor guide travel with the
  package, `author.name` is `DumbMice`, and the `LICENSE` copyright holder changed to `DumbMice` to
  match.

### Fixed

- The contributor release recipe paired `git tag` with `git push --follow-tags`, which pushes only
  annotated tags, so the documented steps would not have published anything. The recipe now creates an
  annotated tag after the version bump.

## [0.1.3] - 2026-10-30

### Changed

- README kept user-facing: development and release instructions moved to `CONTRIBUTING.md`, with a
  single pointer left behind.

## [0.1.2] - 2026-10-30

### Changed

- README documents the release path: trusted publishing through GitHub OIDC, no `NPM_TOKEN`,
  automatic provenance, the tag/version guard, and the option to disallow token publishing.

## [0.1.1] - 2026-10-30

### Changed

- Documentation only: install command moved up, sample output reflowed, README badges added (a
  downloads badge is deferred until the package has statistics).

## [0.1.0] - 2026-10-30

Published at $0.00075 per billable request for both Search and Fetch; failures, timeouts and empty
results are not billed. Validated against the DeepSeek API documentation as of 2026-10-30.

### Added

- `deepseek_search` and `deepseek_fetch`, over `POST /v1/tools/search` and `POST /v1/tools/fetch`.
- Search parameters: `count` (1–50), `ori_question`, `need_content`, `localization`,
  `allowed_domains`, `blocked_domains`, `lang`, `recency`. Fetch parameters: `url`, `max_chars`.
- Result metadata: publication date, authority tier, rerank score and site name, with `site_icon`,
  mapped results and run metadata in `details`.
- Client-side trimming of over-length queries, reporting every removal.
- Retries for `408`, `429`, any `5xx`, network failures and timeouts, three attempts, with
  `retry-after` honoured up to 5 seconds.
- `deepseek_fetch` rejects local and private targets and never unescapes inside code.


[Unreleased]: https://github.com/DumbMice/pi-deepseek-websearch/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/DumbMice/pi-deepseek-websearch/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/DumbMice/pi-deepseek-websearch/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/DumbMice/pi-deepseek-websearch/compare/v0.1.1...v0.1.2
[0.1.1]: https://www.npmjs.com/package/@dumbmice/pi-deepseek-websearch/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/@dumbmice/pi-deepseek-websearch/v/0.1.0
