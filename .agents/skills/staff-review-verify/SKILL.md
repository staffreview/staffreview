---
name: staff-review-verify
description: Verify candidate Staff Review findings (diff or whole-file) and return confirm/reject JSON. Used by staff-review, staff-loop, and staff-section sub-agents.
---

# Staff Review Verify

One verify-agent unit of a staff-level review. Independently re-check candidate
findings against the code — a `base..head` diff (`/staff-review`, `/staff-loop`)
or whole files in the working tree (`/staff-section`), per the **mode** the
orchestrator passes. Return verdicts only; do not post, spawn agents, modify
code, or commit.

## Load

You were spawned to verify findings, so **read `references/verify-guide.md` now
and follow it exactly** — it holds both modes' verification method and the verdict
JSON schema. Don't verify from this page alone.

## Required Parameters

- `mode`: `diff` or `files` (infer from the slug/findings if not named).
- `slug`: the diff under review (`diff` mode) or the whole-tree diff the comments
  are hosted on (`files` mode — context only).
- `candidate findings`: JSON array from one find agent.
