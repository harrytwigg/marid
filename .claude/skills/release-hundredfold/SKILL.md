---
name: release-hundredfold
description: Use when cutting a new hundredfold release for this repo - bumping the version, publishing to npm, creating the GitHub release, and letting the Homebrew formula auto-update. Covers the exact order that matters (npm publish BEFORE publishing the GitHub release).
---

# Releasing hundredfold

The published npm package is **`hundredfold`** (lives in `packages/hundredfold`). The root
package (`hundredfold`) is private; `packages/web` is internal (its version isn't shipped).
Version lives in **one place**: `packages/hundredfold/package.json`.

## How the pieces connect

- **npm**: published manually with `npm publish` from `packages/hundredfold`. The package
  ships `dist/` and `template/` (see its `files`), so you MUST build first.
- **GitHub release**: created for tag `vX.Y.Z`.
- **Homebrew**: `.github/workflows/bump-formula.yml` fires on `release: published`.
  It waits (up to ~5 min) for the npm tarball at
  `registry.npmjs.org/hundredfold/-/hundredfold-X.Y.Z.tgz`, computes its sha256, rewrites
  `Formula/hundredfold.rb`, and pushes the bump to `main`.
- **CI** (`ci.yml`) runs typecheck/test/build on `main` + PRs. It does **not** publish.

> **Order matters:** publish to npm **before** publishing the GitHub release, or the
> formula-bump job will wait and then fail because the tarball isn't on npm yet.

## Steps

1. **Land the work on `main`** (merge the PR). Releases are cut from `main`; the
   formula-bump job also pushes to `main`. Ensure a clean tree: `git status`.

2. **Pick the version.** This is `0.x`, so a minor bump (`0.N.0`) is fine even for
   small breaking changes; patch (`0.x.N`) for fixes only.

3. **Bump + commit** (no `Co-Authored-By: Claude` trailer - repo convention):
   ```bash
   # edit packages/hundredfold/package.json "version"
   git commit -am "chore(release): hundredfold vX.Y.Z"
   ```

4. **Generate and review the instance migration gate.** Resolve the previous
   release tag, then run:
   ```bash
   PREVIOUS_TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' HEAD^)"
   VERSION="$(node -p "require('./packages/hundredfold/package.json').version")"
   pnpm --filter hundredfold migration:generate -- --base-ref "$PREVIOUS_TAG" --version "$VERSION"
   pnpm --filter hundredfold migration:check -- --base-ref "$PREVIOUS_TAG" --version "$VERSION"
   ```
   If there are no instance-template changes, record that fact; do not create an
   empty bundle. Otherwise review the preserved rationale and exact manifest
   paths. The generator owns the payloads and per-file merge instructions.

5. **Build + verify** from repo root:
   ```bash
   pnpm build      # turbo build + copies packages/web/out -> packages/hundredfold/dist/web
   pnpm typecheck && pnpm test
   ```

   Run the exact-tarball upgrade lab. Release work cannot continue if
   `migration:check` or any required upgrade scenario fails.

6. **Publish to npm.** A gitignored npm **automation token** lives at
   **`packages/hundredfold/.npmrc`** (`//registry.npmjs.org/:_authToken=...`). npm reads
   it automatically when publishing from that directory, so it bypasses the
   account's interactive login + 2FA OTP. Publish:
   ```bash
   cd packages/hundredfold && npm publish && cd -
   ```
   - This is the irreversible step - confirm with the maintainer first.
   - If publish fails with `E401`/`EOTP`, the token file is missing or revoked.
     Recreate it at npmjs.com → Access Tokens → Classic → **Automation**, then
     write `//registry.npmjs.org/:_authToken=<token>` to `packages/hundredfold/.npmrc`
     (it's already in `.gitignore` - never commit it).

7. **Tag + push:**
   ```bash
   git tag vX.Y.Z && git push origin main --tags
   ```

8. **Create the GitHub release** (publishing it triggers the Homebrew bump):
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "...release notes..."
   ```
   For a dry run, add `--draft` (drafts do NOT trigger the formula workflow).

9. **Verify**: a `formula: bump to vX.Y.Z` commit lands on `main` within ~5 min
   (check the bump-formula workflow run), and `npm view hundredfold version` is X.Y.Z.

## Notes
- Don't bump `package.json` in the root or `packages/web` - only `packages/hundredfold`.
- If the formula job fails, it's almost always the npm tarball not being live yet;
  re-run the workflow once `npm view hundredfold@X.Y.Z` resolves.

## The first release under the new name

<!-- rename:keep-begin -->
The package used to be published as `jinn-cli`. Before the first release of `hundredfold`, in this order:

1. The npm name `hundredfold` is reserved (a placeholder version) and the npm organisation exists. Confirm with `npm view hundredfold name`.
2. npm Trusted Publishing for `hundredfold` is configured for this repository and the `publish-npm.yml` workflow (the publish job refuses a package whose repository field is not this one).
3. Release as usual. The package carries both binaries: `hundredfold` and `jinn`, the latter a forwarder that says the command has been renamed and then runs `hundredfold`.
4. `Formula/hundredfold.rb` still names the pre-release version and checksum until the bump workflow has run once against the first published version; do not point anyone at `brew install hundredfold` before that.
5. After the first release is on the registry, deprecate the old package so installers learn of the move: `npm deprecate jinn-cli "Renamed to hundredfold: npm install -g hundredfold"`. This is not reversible in spirit (it is a public notice on someone's install page), so it is a decision for the operator, made when the release is out.
6. An installed instance keeps working under its old names; its operator runs `hundredfold doctor --rename --apply` when ready (see `docs/codename-compatibility.md`). The compatibility names are removed two minor releases after this one.
<!-- rename:keep-end -->
