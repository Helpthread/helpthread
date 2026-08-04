# `helpthread-module` CLI

Installs and offline-verifies Helpthread module release artifacts. It
shares its verifier (`src/modules/artifact/`) with the engine itself — this
package adds only the marketplace client, the compiled-in trust store, and
the command-line surface.

## Run it

From the repo root:

```sh
node --import tsx cli/src/main.ts install <module-slug>
node --import tsx cli/src/main.ts verify <tarball> --manifest <path> --signature <path>
```

Or via the package's own bin, once its dependencies are installed:

```sh
./cli/bin/helpthread-module.js install <module-slug>
```

This package has no build step yet: `bin/helpthread-module.js` runs
`src/main.ts` straight from TypeScript source via a `node --import tsx`
shebang. A published, globally-installed CLI would need a bundling step
(`tsup`/`esbuild`) so `tsx` isn't a runtime dependency of every install —
out of scope for HT-116.

## `install`'s download contract

`POST /api/v1/download` returns
`{version, downloadUrl, expiresAt, checksumSha256}` — confirmed against the
service's own handler. `install` consumes two of those fields:
`downloadUrl` (GET it for the bytes) and `version`, which is authoritative
because entitlement can serve an older release than the one requested — a
lapsed license receives the version its snapshot names.

Nothing in that response is trusted for integrity. The artifact's identity
comes from the signed manifest alone: after download, `install` checks the
digest, the byte length, the signature against the compiled-in trust store,
**and** that the manifest's own `module` and `semver` match what was asked
for and served. A valid signature proves an artifact is authentic; it does
not prove it is the one you ordered, since every first-party release shares
a signing key.

## Trust store

`cli/src/trust-store.ts` compiles in the publisher public keys this CLI
will accept a manifest signature from. It is never populated from the
catalog response — see that file's doc comment for why.
