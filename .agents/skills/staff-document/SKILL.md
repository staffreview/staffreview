---
name: staff-document
description: Convert a GitHub PR review comment URL into a markdown docs entry under `.staffreview/docs/`. Use when the user asks to document a GitHub review comment as a staff-review example.
---

# Staff Document

Save a GitHub PR review comment (and its surrounding diff) as a standalone markdown example in this repo's `.staffreview/docs/` directory. These examples become reference material for future `/staff-review` and `/staff-resolve` runs.

## Inputs

You will be given a GitHub URL of the form:

```
https://github.com/<owner>/<repo>/pull/<number>#discussion_r<commentId>
```

…or an issue comment URL, or a PR conversation comment URL.

## Procedure

1. Use `gh` to fetch the comment, its diff hunk, and the resolving reply if any:

   ```bash
   gh api repos/<owner>/<repo>/pulls/<number>/comments/<commentId> --jq '.'
   gh api repos/<owner>/<repo>/pulls/<number>/comments \
     --jq '[.[] | select(.in_reply_to_id == <commentId>)]'
   ```

   For a top-level issue comment use `repos/<owner>/<repo>/issues/comments/<commentId>`.

2. Identify:
   - The file and line range the review comment targeted.
   - The original code that was being criticized (`diff_hunk`).
   - The fix — either subsequent commit(s) on the PR or text in the reply thread.
   - The reviewer's reasoning.

3. Write a new file under `.staffreview/docs/<slug>.md`. Pick a slug that describes the **lesson**, not the file (e.g. `avoid-mutating-props.md`, not `comment-r12345.md`).

4. Use this exact frontmatter and section structure:

   ```markdown
   ---
   source: <PR URL>
   tags: [<short, lowercase, hyphenated tags>]
   ---

   # <One-line lesson title>

   ## Context
   <1–2 sentences on what the change was doing and where>

   ## The issue
   <Reviewer's complaint, restated for clarity. Cite the file and line.>

   ## Original code

   ```<lang>
   <the snippet from diff_hunk, just the old side>
   ```

   ## Fix

   ```<lang>
   <the snippet after the fix>
   ```

   ## Why it matters
   <1–3 sentences explaining the failure mode and the rule of thumb that follows.>
   ```

5. Keep entries short — one screenful. The docs is meant to be skimmed.

6. After writing, print the relative path of the new file.

## Don'ts

- Don't include reviewer/author names or personal attributions.
- Don't include the entire diff if a 10-line hunk tells the story.
- Don't redact lessons just because the original code is from a private repo — the user has chosen to capture it; their privacy decision, not yours.
- Don't overwrite an existing docs file with the same slug; pick a more specific name.
