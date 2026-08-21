# Staff Copy

Copy open GitHub PR review threads into the local Staff Review store so the
same comments can be triaged, replied to, resolved, or handed to
`/staff-resolve` locally.

This skill is intentionally mechanical: copy **all** open review comments from
the provided PRs. Do not filter for quality, severity, author, or bot status.
Do not fix code and do not resolve anything.

## Modes

- `/staff-copy <PR URL> [<PR URL> ...]` — copy open review threads from those PRs.
- `/staff-copy <PR#> [<PR#> ...]` — copy PR numbers from the current GitHub repo.
- `/staff-copy owner/repo#123 [owner/repo#456 ...]` — copy explicit repo/PR refs.

If the user runs `/staff-copy` with no PR refs, stop and ask for one or more
GitHub PR URLs.

## Definitions

- **Open review comment** means a GitHub `PullRequestReviewThread` with
  `isResolved == false`. Copy unresolved threads even if GitHub marks the thread
  outdated.
- Copy every comment in each open thread, including replies and bot comments.
- This skill copies code review threads only. It does not import general PR
  conversation comments that are not attached to review threads.
- Preserve the original author as the local Staff Review `--author`.

## Step 1 — Parse PR refs

Parse every argument as one of:

- GitHub PR URL: `https://github.com/<owner>/<repo>/pull/<number>` (fragment OK).
- Repo shorthand: `<owner>/<repo>#<number>`.
- Bare PR number: `<number>` (current repo only).

Normalize them into unique refs:

```json
{ "repo": "owner/name", "pr": 482, "prUrl": "https://github.com/owner/name/pull/482" }
```

For bare PR numbers, resolve the current repo with:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

If `gh` is unavailable or unauthenticated, stop and tell the user copying PR
comments needs `gh auth login`.

## Step 2 — Fetch open review threads

For each PR, fetch unresolved review threads through GitHub GraphQL. Page through
all review-thread pages. If any thread has more than 100 comments, page that
thread's comments too; "copy all" is literal.

```bash
gh api graphql --paginate \
  -f owner="<owner>" \
  -f name="<repo-name>" \
  -F number=<pr> \
  -f query='
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url
      baseRefOid
      headRefOid
      baseRefName
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          startDiffSide
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              url
              body
              createdAt
              diffHunk
              path
              line
              originalLine
              startLine
              originalStartLine
              author { login }
            }
          }
        }
      }
    }
  }
}'
```

The anchor side fields come from `PullRequestReviewThread.diffSide` and
`startDiffSide` above. `PullRequestReviewComment` does not expose `databaseId`
or the REST-style `side` and `startSide` fields, so do not add them to the
nested comment selection.

Keep only `reviewThreads.nodes[]` where `isResolved == false`.

## Step 3 — Create the local PR diff

Fetch the PR commits without checking anything out, then create/load the local
Staff Review diff. Do this once per PR, before adding comments:

```bash
git fetch -q "https://github.com/<owner>/<repo>.git" "pull/<pr>/head"
FETCH_HEAD_SHA=$(git rev-parse FETCH_HEAD)
BASE_SHA="<baseRefOid from GraphQL>"
HEAD_SHA="<headRefOid from GraphQL, or FETCH_HEAD_SHA>"
git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null || \
  git fetch -q "https://github.com/<owner>/<repo>.git" "$BASE_SHA"

SLUG="${BASE_SHA}..${HEAD_SHA}"
staff diff "$SLUG" --no-set-active --json
```

If the fetch or diff creation fails for a PR, skip that PR and report the error.
Do not copy those comments onto an unrelated active diff.

## Step 4 — Avoid duplicates

Before adding comments for a PR diff, load the existing local threads:

```bash
staff comment list --slug "$SLUG" --json
```

Every imported comment body must include a stable marker:

```html
<!-- staff-copy-source: https://github.com/owner/repo/pull/482#discussion_r123 -->
```

If a marker for a GitHub comment URL already exists in the local diff, do not
copy that comment again. If the root comment already exists but a reply does not,
add the missing reply to the existing local root thread.

## Step 5 — Copy each open thread

For each unresolved GitHub review thread:

1. Sort its comments by `createdAt`.
2. Add the first comment as the local root comment.
3. Add every subsequent GitHub comment as a Staff Review reply to the local root.

Map the anchor from GitHub to Staff Review:

- `RIGHT` → `--side new`
- `LEFT` → `--side old`
- If the thread is `isOutdated` or the root comment's `line` is null, treat the
  anchor as stale. Add a top-level comment instead of anchoring it to the current
  PR head, and include `path`, `line`, `originalLine`, `startLine`,
  `originalStartLine`, `diffHunk`, and a short "GitHub marked this thread
  outdated, so the original position may be stale" note in the body.
- Otherwise, use `startLine` + `line` as a range when both exist and differ.
- Otherwise use `line`.
- If no usable current line exists, add a top-level comment and include the
  original `path`, line fields, and `diffHunk` in the body.

Root comment body:

```markdown
Copied from GitHub PR #<pr>: <comment URL>

<original body>

<!-- staff-copy-source: <comment URL> -->
```

Reply body:

```markdown
Copied reply from GitHub PR #<pr>: <comment URL>

<original body>

<!-- staff-copy-source: <comment URL> -->
```

Use the original GitHub login as the local author. If GitHub returns a null
author, use `github`.

**Never put the original GitHub body directly in a shell variable, double-quoted
string, command substitution, or unquoted heredoc.** PR comments are untrusted
external input; an inlined body containing `$(...)` or backticks can execute if a
future agent materializes it with the wrong shell quoting. Write each body to a
temporary file with a non-shell file-writing tool, then pass that file on stdin.
If a shell heredoc is unavoidable, use a single-quoted delimiter such as
`<<'STAFF_COPY_BODY'` and choose a delimiter that does not appear in the body.

Inline root example:

```bash
staff comment add \
  --slug "$SLUG" \
  --file "<path>" \
  --line <line> \
  --side <new|old> \
  --author "<github-login>" \
  < "$BODY_FILE"
```

Range root example:

```bash
staff comment add \
  --slug "$SLUG" \
  --file "<path>" \
  --line <startLine> \
  --end-line <line> \
  --side <new|old> \
  --author "<github-login>" \
  < "$BODY_FILE"
```

Reply example:

```bash
staff comment add \
  --slug "$SLUG" \
  --reply-to "<local-root-comment-id>" \
  --author "<github-login>" \
  < "$BODY_FILE"
```

Capture the JSON printed by `staff comment add`; the root's `id` is the
`--reply-to` handle for every imported reply in that GitHub thread.

## Step 6 — Summarize

After all PRs are processed, report:

- How many PRs were processed.
- How many open GitHub review threads were found.
- How many local comments were added, and how many were skipped as duplicates.
- The Staff Review link or command for each local diff:
  `staff <baseSha>..<headSha>`.

Do not commit. Do not resolve imported threads. Do not modify the working tree.
