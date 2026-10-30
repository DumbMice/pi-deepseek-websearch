# Working on this repository

Instructions for anyone — human or coding agent — changing
`@dumbmice/pi-deepseek-websearch`. For what the extension does and how to install it, read
[README.md](README.md).

## Layout

```
src/index.ts              the extension: two tool registrations, transport, formatting, guards
test/index.test.ts        node:test suite; global fetch is stubbed, nothing touches the network
docs/docs-alignment.md    every client-side deviation from DeepSeek's published API contract
README.md                 user-facing documentation
AGENTS.md                 this file
CONTRIBUTING.md           four-line pointer to this file (GitHub convention)
CHANGELOG.md              Keep a Changelog format, released and unreleased entries
package.json              scripts, engines, the files allow-list, pi.extensions entry point
tsconfig.json             the strict / noEmit settings used by typecheck
.github/workflows/        test.yml (Node 22 and 24) and publish.yml (trusted publishing)
```

## Requirements and commands

Node >= 22.6 (`engines`; the entry point is TypeScript and the test runner uses
`--experimental-strip-types`). devDependencies stay limited to `typescript` and `@types/node`; the
publish workflow installs with `npm ci`, the test matrix with `npm install`.

```bash
npm install           # devDependencies only: typescript, @types/node
npm test              # node:test, mocked HTTP, no key required
npm run typecheck     # tsc --noEmit, strict
npm run pack:check    # tarball contents: package.json, src, docs, README, AGENTS, CONTRIBUTING, LICENSE, CHANGELOG
```

## Design decisions worth preserving

These are the invariants the suite protects. Changing one means changing its test, any affected
README text, the matching `docs/docs-alignment.md` entry (or marking that item silent), and adding a
`CHANGELOG.md` line — all in the same commit.

- **No runtime dependencies.** The only import is `node:net`. Everything else is the platform. Do not
  add a dependency for argument validation, HTTP, or markdown cleanup.
- **Plain JSON Schema, not TypeBox.** The `parameters` are literal JSON Schema objects rather than
  TypeBox builders. That keeps the schema out of the dependency graph, which is the point of the
  no-runtime-dependencies rule. Do not replace them with `Type.Object` imports.
- **A fitting query is never rewritten.** `fitQuery` returns the caller's text untouched when it fits,
  apart from stripped leading/trailing whitespace. Only an over-long query is tokenised and trimmed.
- **Trimming is bounded and reported.** Shed filters (recency, language, domains) first, then trailing
  words, then a code-point tail cut; drop a dangling operator or unmatched quote; record every removal
  in `dropped`. Whitespace stripped from `query`, `ori_question` and `localization` before use is
  silent (register item 3).
- **Cost follows the raw response.** `estimatedCostUsd` is keyed to `rawResults.length`, not to what
  survives client-side filtering, because DeepSeek bills a non-empty result set.
- **A malformed 200 is an error.** A body without a `results` array is rejected; an empty array is a
  legitimate "no results".
- **Abort is not failure.** The caller's abort reason is preserved on every path, including retry
  backoff, and an already-aborted signal issues no request.
- **Never trust response field types.** `formatResult` degrades per field instead of failing the call.
- **Code points, not UTF-16 units.** Every documented length cap (`128`, `8192`, `max_chars`, the
  4,000-character result body) uses `Array.from`.
- **Endpoint and credential precedence is deliberate.** Key: pi's `deepseek` provider, then
  `DEEPSEEK_API_KEY`. Base URL: `PI_DEEPSEEK_BASE_URL`, then `DEEPSEEK_SEARCH_BASE_URL`, then
  `https://api.deepseek.com`, with a trailing slash or `/v1` suffix stripped. The bare
  `DEEPSEEK_BASE_URL` is ignored on purpose — other tools point it at an OpenAI-compatible `/v1`
  root. Pinned by the `baseUrl` test.
- **The private-address guard is a policy, not a protocol rule.** It normalises trailing dots and
  decodes IPv4 embedded in IPv6 (`::ffff:127.0.0.1`, `::7f00:1`, NAT64 `64:ff9b::…`). It performs no
  DNS lookup, so a public hostname resolving to a private address is intentionally not caught.
- **No secrets in output.** The API key is redacted from upstream error text and network failures, and
  error bodies are sliced before display. The redactor only substitutes keys longer than 8 characters,
  which every real DeepSeek key is.

## Adding or changing a tool

Register the tool with `pi.registerTool({ … })` inside the default export; pi finds the entry point
through `package.json` → `pi.extensions`.

- `name`, `label`, `description`, `promptSnippet` are model-facing. State when to use the tool and what
  comes back, and keep the parameter descriptions truthful about limits.
- `parameters` is literal JSON Schema (`type: "object"`, `required`, `additionalProperties: false`).
- `execute(toolCallId, params, signal, onUpdate, ctx)` reads credentials through
  `ctx.modelRegistry`, passes the abort signal into `postDeepSeek`, and returns
  `{ content: [{ type: "text", text }], details }`.
- `details` carries machine-readable metadata only — counts, what was trimmed or discarded, cost. Do
  not repeat the rendered text, and keep the object JSON-serialisable (no `undefined`, `NaN` or
  `Infinity`).
- Then update the README (parameters and behaviour), `docs/docs-alignment.md` if behaviour deviates,
  and `CHANGELOG.md` under `[Unreleased]`. Keep `package.json` `files` and `pi.extensions` in step.

## Tests

`test/index.test.ts` stubs `globalThis.fetch` (`harness()` and `stubFetch()`) and asserts behaviour,
not implementation trivia. Restore the stub in a `finally` block. When fixing a bug, add the failing
case first; several rounds of review found real defects this way (operator-tail trimming, quote
parity, abort reasons, malformed bodies). Run `npm test` before every commit; CI repeats it on Node 22
and 24 together with `npm run typecheck` and `npm run pack:check`.

### Try a change locally

There is no build step: pi loads `src/index.ts` through `package.json` → `pi.extensions`.

```bash
pi -e /absolute/path/to/pi-deepseek-websearch    # one session, straight from the working copy
```

A live call needs a real key and is billed $0.00075 per successful request; one search and one fetch
is enough to check rendering. `npm test` needs neither key nor network.

## Documentation conventions

- `README.md` is for users of the extension: what the tools do, when to use them, parameters, cost,
  observable behaviour, troubleshooting. No implementation inventories, no CI or release steps.
- `docs/docs-alignment.md` is the register of deliberate differences from DeepSeek's API. Add an item
  when behaviour deviates and pin it with a test wherever the behaviour is observable; items that
  produce no output signal are marked _(silent)_. `DOCS_SNAPSHOT` appears in the `src/index.ts` header
  and constant and at the top of the register — keep them in step.
- `CHANGELOG.md` follows Keep a Changelog. Put unreleased work under `[Unreleased]` with
  Added/Changed/Fixed headings; add the version heading when the release is tagged.
- `AGENTS.md` (this file) holds contributor, architecture and release material.

## Release process

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers): the workflow
exchanges a GitHub OIDC token for a short-lived credential, so the repository holds no `NPM_TOKEN`
and no long-lived write token is needed. Because the repository is public, npm attaches a provenance
attestation automatically — no `--provenance` flag.

```bash
npm version patch --no-git-tag-version    # or minor/major; the working tree must be clean
VERSION="$(node -p "require('./package.json').version")"
# add the CHANGELOG.md entry for this version, then:
git add -A                                 # include any new docs; -am skips untracked files
git commit -m "chore: release v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main --follow-tags
```

`--follow-tags` pushes only **annotated** tags, which is why the recipe uses `git tag -a`; a
lightweight tag would stay local and publish nothing. `.github/workflows/publish.yml` runs the suite
and the typecheck, refuses to publish when the tag and `package.json` version disagree, then publishes.
A manual `workflow_dispatch` run skips the tag guard and publishes the selected ref as-is — use it only
to retry a failed tag build.

Optionally, after a successful trusted publish, set the package's *Publishing access* to "Require
two-factor authentication and disallow tokens": trusted publishing keeps working, token publishing
stops.

## Commits and security

- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`); release commits are
  `chore: release vX.Y.Z`.
- Style: tabs and double quotes, no formatter or linter in the repository. Do not reformat untouched
  lines.
- Report vulnerabilities through GitHub's private advisory form (Security → Report a vulnerability),
  not a public issue.
- Contributions are accepted under the MIT license (see [LICENSE](LICENSE)).
