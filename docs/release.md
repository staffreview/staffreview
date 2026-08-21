# Release Process

Use this checklist to publish a new Staff Review release.

## Prerequisites

- Be on `main` with a clean worktree.
- Make sure GitHub auth can push tags and edit releases: `gh auth status`.
- Confirm the next version from the changelog and latest tag:
  `gh api repos/staffreview/staffreview/releases/latest --jq .tag_name`.

## Prepare the Release Commit

1. Update `apps/staffreview/package.json` to the new version.
2. Update the matching workspace version in `bun.lock`.
3. Add a new top entry in `apps/web/content/docs/changelog.mdx`.
4. Run:

   ```sh
   bun run check
   bun run --cwd apps/staffreview test
   ```

5. Commit the release prep:

   ```sh
   git add apps/staffreview/package.json bun.lock apps/web/content/docs/changelog.mdx
   git commit -m "chore(release): X.Y.Z"
   ```

## Tag and Publish

The GitHub release workflow runs on `v*` tag pushes, builds binaries for
darwin/linux on arm64/x64, and publishes `@staffreview/staff` to GitHub
Packages. The tag must match the package version (for example, package version
`1.11.0` requires tag `v1.11.0`).

```sh
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main
git push origin vX.Y.Z
gh run list --workflow Release --limit 5
gh run watch <run-id> --exit-status
```

Verify the release contains `SHA256SUMS` plus all four `staff-*` binaries:

```sh
gh api repos/staffreview/staffreview/releases/tags/vX.Y.Z \
  --jq '{tag:.tag_name, assets:[.assets[].name], url:.html_url}'
```

Verify the package version is available from GitHub Packages:

```sh
npm view @staffreview/staff@X.Y.Z version \
  --registry=https://npm.pkg.github.com
```

The npm command must be authenticated with a GitHub token that has
`read:packages` permission. The workflow uses `GITHUB_TOKEN` with
`packages: write` permission to publish and safely skips a version that is
already present when a workflow run is retried.

## Update Homebrew Tap

After release assets are available, update `staffreview/homebrew-tap`:

1. Download checksums:

   ```sh
   curl -L https://github.com/staffreview/staffreview/releases/download/vX.Y.Z/SHA256SUMS
   ```

2. In `Formula/staff.rb`, update `version` and each platform `sha256`.
3. Commit to the tap:

   ```sh
   git commit -am "staff X.Y.Z"
   git push origin main
   ```

If updating through the GitHub API instead of a clone, verify the final formula
by reading `https://github.com/staffreview/homebrew-tap/blob/main/Formula/staff.rb`.

## Post-Release Checks

- Confirm the GitHub release page is published.
- Confirm the matching `@staffreview/staff` GitHub Package version is published.
- Confirm `main` is clean and synced: `git status --short --branch`.
- Smoke-test install/update paths when practical:
  `brew update && brew upgrade staffreview/tap/staff`, plus either
  `npm install --global @staffreview/staff@X.Y.Z` or
  `bun install --global @staffreview/staff@X.Y.Z`.
