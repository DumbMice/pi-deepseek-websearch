# pi extension API alignment

How this extension's use of pi's extension API relates to the documented contract, and which exact
versions that was established against.

| Component | Tested version | Recorded in |
|---|---|---|
| `@earendil-works/pi-coding-agent` | **1.5.2** | `PI_API_SNAPSHOT` in `src/index.ts` |
| `@earendil-works/pi-schema` (tool validation) | ships with pi 1.5.2 | this file (notes below) |
| Node | 22.23.2 (tested); floor 22.19, the floor pi itself requires | `package.json` `engines`, README *Install* |
| DeepSeek Search & Fetch API | docs snapshot 2026-10-30 | `DOCS_SNAPSHOT`; see `docs/docs-alignment.md` |

Last verified **2026-11-12**. Bump a row here, its constant where one exists, and the README
*Install* line in the same commit as the change that depends on it.

## What this extension actually uses

The contract is followed where it is documented, and nothing here calls pi internals:

- `pi.registerTool()` with a hand-written JSON Schema `parameters` object. pi validates any JSON
  Schema; the `typebox` import in the docs is a convenience, and avoiding it keeps the package
  dependency-free.
- `execute(toolCallId, params, signal, onUpdate, ctx)` — the five-argument form.
- `ctx.modelRegistry.getApiKeyForProvider("deepseek")` for credentials, falling back to
  `DEEPSEEK_API_KEY`.
- The `pi.extensions` manifest entry in `package.json`.

It registers no commands, hooks, renderers or UI, so a release that only changes those surfaces
cannot affect this package.

## Notes on the 1.5.x line

1. **Tool validation moved to `@earendil-works/pi-schema` in 1.5.0.** TypeBox features outside JSON
   Schema no longer apply; plain JSON Schema tools now get the same coercion as TypeBox tools
   (numeric strings to numbers, `"true"` to `true`, a single value to a one-item array, `null` in an
   optional property dropped). This package uses only JSON Schema keywords, so nothing was lost, and
   the coercion is a net improvement: `allowed_domains: "example.com"` now arrives as
   `["example.com"]` instead of being rejected.
2. **1.5.2's breaking changes do not touch this package.** They cover `GrepOperations.readFile`
   context lines, the omission of an empty `"tools": []` array for OpenAI-compatible models, and new
   `pi.registerMarkdownTransformer()` options. This package registers no renderers and does not
   implement grep.
3. **Package changelogs are read from the package root by 1.5.x.** `CHANGELOG.md` uses the required
   `## [x.y.z]` headings, so extension updates surface our notes without a `pi.changelogPath` entry.
4. **Node floor.** pi 1.5.1 declares `>=22.19.0`; this package declares the same floor, because it
   only runs inside pi.
