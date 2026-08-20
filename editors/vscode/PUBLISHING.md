# Publishing the extension

Releases are tag-driven: the `vscode-extension` job in
[`.github/workflows/release.yml`](../../.github/workflows/release.yml) builds,
checks, packages, and publishes to both marketplaces. It skips whichever
marketplace has no token configured, so a release never fails on a registry that
is not set up.

Everything below is one-time account setup. It cannot be automated — both
registries require a human to accept terms and mint a token.

## Why both registries

The Microsoft marketplace is not the whole audience. **Cursor, Windsurf, and
VSCodium cannot install from it at all** — they resolve extensions through Open
VSX. Publishing to only one reaches roughly half the people who would use this.

## VS Code Marketplace

1. Sign in to [Azure DevOps](https://aex.dev.azure.com) with a Microsoft
   account and create an organization if you have none. The organization is
   only a container for the token; nothing is hosted there.
2. Create the publisher at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage).
   The publisher ID must be **`arthurpanhku`** — it is already in
   `package.json`, and the extension's permanent identity is
   `arthurpanhku.dvalincode-vscode`. It cannot be changed after the first
   publish without abandoning the listing.
3. Mint a Personal Access Token in Azure DevOps → *User settings* → *Personal
   access tokens* → *New Token*:
   - **Organization: `All accessible organizations`.** This is the one people
     get wrong. A token scoped to a single organization authenticates and then
     fails the publish with a 401 that does not explain why.
   - **Scopes:** *Custom defined* → *Marketplace* → **Manage**.
   - Expiry is capped at one year. When it lapses, releases start warning and
     skipping rather than failing — see "When a token expires" below.
4. Add it as the repository secret **`VSCE_PAT`**
   (*Settings* → *Secrets and variables* → *Actions*).

## Open VSX

1. Sign in at [open-vsx.org](https://open-vsx.org) with GitHub.
2. **Sign the Eclipse Publisher Agreement.** This needs an
   [Eclipse Foundation account](https://accounts.eclipse.org/user/register) and
   is a genuine legal step, not a checkbox. Namespace creation fails until it is
   done, which is where most first-time Open VSX publishes stall.
3. Generate an access token from your Open VSX profile page and add it as the
   repository secret **`OVSX_PAT`**.
4. Claim the namespace once, from a machine that has the token:

   ```sh
   npx ovsx create-namespace arthurpanhku -p "$OVSX_PAT"
   ```

   The namespace must match the `publisher` field. Creating it is idempotent
   enough to retry, but it will not transfer to another account later.

## Releasing

With both secrets in place, a version tag publishes everywhere:

```sh
git tag v0.18.0 && git push origin v0.18.0
```

The job refuses to publish when the tag disagrees with
`editors/vscode/package.json`, so **bump the extension version in the same
commit as the CLI version**. They are deliberately kept equal: a given extension
version and CLI version should always mean the same scanner.

Re-running a release is safe. Both publishes check whether the version is
already on the registry and skip it rather than failing, so a moved tag or a
retried job does not turn the release red.

The `.vsix` is attached to the GitHub Release either way, so the extension stays
installable by hand while a marketplace publish is skipped or still propagating:

```sh
code --install-extension dvalin-security-scan.vsix
```

## Publishing by hand

Only needed for the very first publish if you would rather watch it happen:

```sh
cd editors/vscode
npm ci && npm run check && npm run build && npm run package
npx vsce publish --no-dependencies --packagePath dvalin-security-scan.vsix   # needs VSCE_PAT
npx ovsx publish dvalin-security-scan.vsix                                    # needs OVSX_PAT
```

## When a token expires

The job treats a missing token as "not configured" and skips with a warning
rather than failing the release. That keeps a lapsed credential from blocking a
CLI release, but it also means **a silent skip looks like a successful
release**. If a version reaches npm and not the marketplaces, check the release
run's warnings first — the token is the usual answer.
