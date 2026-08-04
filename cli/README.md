# `helpthread-module` CLI

Installs and offline-verifies Helpthread module release artifacts. It
shares its verifier (`src/modules/artifact/`) with the engine itself — this
package adds only the marketplace client, the compiled-in trust store, and
the command-line surface.

## Run it

From the repo root, straight from TypeScript source (useful while developing):

```sh
node --import tsx cli/src/main.ts install <module-slug>
node --import tsx cli/src/main.ts verify <tarball> --manifest <path> --signature <path>
```

Or build the package and run its own bin, which is what a real install runs:

```sh
npm run build -w cli
./cli/dist/main.js install <module-slug>
```

Once published, an operator installs `@helpthread/module` but still runs
the `helpthread-module` command:

```sh
npm install -g @helpthread/module
helpthread-module install <module-slug>

# or without a global install:
npx @helpthread/module install <module-slug>
```

## Building and packing

`npm run build -w cli` bundles `cli/src/main.ts` — and everything it
imports, including the shared verifier at `src/modules/artifact/**` — into
a single, package-contained `cli/dist/main.js` via esbuild (see
`cli/scripts/build.mjs`). That bundle is what `bin.helpthread-module`
points at, and it runs on plain Node with no dev tooling: no `tsx`, no
TypeScript, no repo-relative imports. `files` in `package.json` limits a
pack/publish to exactly `dist/`, `README.md`, and `LICENSE`.

`prepack`/`prepublishOnly` both run the build, so a stale bundle can never
ship. This package is still `"private": true` — nothing here publishes it,
it only makes publishing possible.

The package name is the scoped `@helpthread/module` (npm org: `helpthread`);
the command it installs stays the unscoped `helpthread-module` — package
name and bin name are independent, so `npm i -g @helpthread/module` still
gives you a `helpthread-module` command, and `npx @helpthread/module install
<slug>` works without a global install. A scoped package defaults to
*restricted* on npm, which would silently fail (or silently go private on a
paid account) on a first publish; `publishConfig.access: "public"` in
`package.json` opts it into a public publish instead.

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
