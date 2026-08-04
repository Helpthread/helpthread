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

`POST /api/v1/download` on the marketplace requires a valid license key,
which this repo does not hold. The success response shape was not directly
observable while building this CLI — only the `401` error shape
(`{"error":{"code":"unauthorized","message":"..."}}`, verified against the
live deployment) was. `install` assumes a `200` response body of
`{"downloadUrl": "<signed URL>"}`, GETs that URL, and treats its bytes as
the tarball. If the real contract differs, `cli/src/catalog.ts`'s
`requestDownloadUrl`/`DownloadResponse` is the only place that needs to
change.

## Trust store

`cli/src/trust-store.ts` compiles in the publisher public keys this CLI
will accept a manifest signature from. It is never populated from the
catalog response — see that file's doc comment for why.
