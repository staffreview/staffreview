# Vendored Informant Pi extensions

`informant-subagents.ts` and `informant-footer-events.ts` are vendored from
`InformantDev/informant` commit `39fc208d72ce40d1d3948932e766fc8ef44a4cd3`.
The package they originate from is private and unpublished, so the Staff Review
job bakes these trusted sources into its prepared container image.

The subagent extension is locally patched for GitHub's current GraphQL schema:
`PullRequestReviewComment` uses `fullDatabaseId` and does not expose `side` or
`startSide`. The query aliases `fullDatabaseId` to the extension's existing
`databaseId` property and derives comment side values from the containing
`PullRequestReviewThread.diffSide` and `startDiffSide` fields.

When refreshing these files, preserve the schema patch and the extension's
review-workspace hardening, then update the source commit above.
