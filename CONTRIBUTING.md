# Contributing

Development and release notes for `@dumbmice/pi-deepseek-websearch`. Nothing here is needed to *use*
the extension — see [README.md](README.md) for that.

## Requirements

Node >= 22.6 (`engines`; the shipped entry point is TypeScript, and the test runner uses
`--experimental-strip-types`).

## Development

```bash
npm install           # devDependencies only (typescript, @types/node)
npm test              # node:test, 68 tests, mocked HTTP — no API key or network needed
npm run typecheck     # tsc --noEmit, strict
npm run pack:check    # tarball contents (no tests, no devDependencies)
```

The suite covers query trimming order and the 128-character cap, caller-spacing preservation,
documented validation rules, metadata rendering (`authority: -1`, score annotation,
summary/snippet/content precedence, malformed fields), retry classification for every documented
status, key redaction, URL safety including encoding bypasses, abort handling, and both tool call
shapes.

Tests never touch the network: `globalThis.fetch` is stubbed, so no API key is required.

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
shipping the wrong number.

For maximum safety the package's *Publishing access* can then be set to "Require two-factor
authentication and disallow tokens": trusted publishing keeps working, token publishing stops.

## Documentation conventions

- `README.md` is user-facing: what the tools do, how to install and configure them, behaviour
  worth knowing, caveats, and the documented deviations from DeepSeek's API docs.
- Contributor and CI material lives here, not in the README.
- Behaviour claims are pinned by tests. If you change a documented number (retry counts, caps,
  timeouts) or a disclosure in the README's *Docs alignment* section, change the test or the
  disclosure in the same commit.
