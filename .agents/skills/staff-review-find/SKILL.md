---
name: staff-review-find
description: Find candidate issues in an assigned slice of a Staff Review diff (or assigned whole files) and return JSON. Used by staff-review, staff-loop, and staff-section sub-agents.
---

# Staff Review Find

One find-agent unit of a staff-level review. Depending on the **mode** the
orchestrator passes, you review either a `base..head` **diff** through assigned
review areas (`/staff-review`, `/staff-loop`) or assigned **whole files** of the
existing code (`/staff-section`). Return candidate findings only; do not post,
spawn agents, modify code, or commit.

## Load

You were spawned to run a review, so **read `references/find-guide.md` now and
follow it exactly** — it holds both modes' review method, the review areas, the
settled-comment checks, and the output JSON schema. Don't review from this page
alone.

## Required Parameters

- `mode`: `diff` or `files` (infer from the params below if not named).
- `slug`: the diff to review (`diff` mode) or the diff comments are hosted on
  (`files` mode — for existing-comment checks only).
- `review areas` *(diff mode)*: area numbers assigned by the orchestrator.
- `files` *(files mode)*: assigned file paths, or a large-file line range.
- `docs lessons`: assigned `.staffreview/docs/` filenames, or `none`.
