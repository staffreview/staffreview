# Release Process

Use this checklist to publish a new Staff Review release.

## Prerequisites

- Be on `main` with a clean worktree.
- Make sure GitHub auth can push tags and edit releases: `rtk gh auth status`.
- Confirm the next version from the changelog and latest tag:
  `rtk gh api repos/staffreview/staffreview/releases/latest --jq .tag_name`.

## Prepare the Release Commit

1. Update `apps/staffreview/package.json` to the new version.
2. Update the matching workspace version in `bun.lock`.
3. Add a new top entry in `apps/web/content/docs/changelog.mdx`.
4. Run:

   ```sh
   rtk bun run check
   rtk bun run --cwd apps/staffreview test
   ```

5. Commit the release prep:

   ```sh
   rtk git add apps/staffreview/package.json bun.lock apps/web/content/docs/changelog.mdx
   rtk git commit -m "chore(release): X.Y.Z"
   ```

## Tag and Publish

The GitHub release workflow runs on `v*` tag pushes and builds binaries for
darwin/linux on arm64/x64.

```sh
rtk git tag -a vX.Y.Z -m "vX.Y.Z"
rtk git push origin main
rtk git push origin vX.Y.Z
rtk gh run list --workflow Release --limit 5
rtk gh run watch <run-id> --exit-status
```

Verify the release contains `SHA256SUMS` plus all four `staff-*` binaries:

```sh
rtk gh api repos/staffreview/staffreview/releases/tags/vX.Y.Z \
  --jq '{tag:.tag_name, assets:[.assets[].name], url:.html_url}'
```

## Update Homebrew Tap

After release assets are available, update `staffreview/homebrew-tap`:

1. Download checksums:

   ```sh
   rtk curl -L https://github.com/staffreview/staffreview/releases/download/vX.Y.Z/SHA256SUMS
   ```

2. In `Formula/staff.rb`, update `version` and each platform `sha256`.
3. Commit to the tap:

   ```sh
   rtk git commit -am "staff X.Y.Z"
   rtk git push origin main
   ```

If updating through the GitHub API instead of a clone, verify the final formula
by reading `https://github.com/staffreview/homebrew-tap/blob/main/Formula/staff.rb`.

## Post-Release Checks

- Confirm the GitHub release page is published.
- Confirm `main` is clean and synced: `rtk git status --short --branch`.
- Smoke-test install/update paths when practical:
  `brew update && brew upgrade staffreview/tap/staff`.
