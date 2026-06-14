# Staff Review Evals

These evals compare how different Staff Review releases and agent/model versions
perform the Staff Review skills. The default path prepares scratch repositories,
runs Codex CLI against each case prompt, and scores the resulting `.staffreview`
artifacts.

## Commands

Run evals:

```bash
bun run eval
```

That opens Clack prompts in this order:

1. Select the skills to eval. All are selected by default; press `a` to toggle all.
2. Select the Staff Review versions to eval.
3. Select the explicit Codex models to eval.
4. Select how many times to run each version/model. The default is 1.

The runner builds the selected skill x version x model matrix, prepares each
suite, runs Codex CLI for every case, prints a score table, writes a
`report.html`, and opens that report in the browser for interactive runs. The
HTML report includes every posted review comment, whether the rubric matched it
or treated it as a noise candidate, and links to the fixture source files and
Codex logs. If a selected skill does not exist in a release, that release skips
those cases instead of failing.

Scoring asks a separate Codex judge to semantically match expected findings to
posted review comments and grade each matched comment's body quality. Each
finding earns up to 25 judge-awarded quality points plus deterministic anchor
and priority points, so comments that use the right phrases but are wrong,
misleading, vague, or weakly actionable get little or no credit. The judge uses
the default Codex model configuration by default, not the model being evaluated.
Use `--judge-model <model>` only when intentionally comparing evaluator
behavior, or `--no-judge`/`STAFF_EVAL_JUDGE=0` for debugging the old
deterministic scorer.

By default the runner invokes Codex through `zsh -lc` and prefers
`~/.bun/bin/codex` before falling back to `codex` on `PATH`. Target eval runs
must pass an explicit model id; the runner does not offer or accept the Codex
default config as a model target because that can vary between machines and
over time.

Codex work runs in parallel. By default, concurrency is the largest selected
slice count across skills, versions, models, and run count. Override it with
`--concurrency <n>` or `STAFF_EVAL_CONCURRENCY=<n>` when you want to trade speed
against local/API load.

Use `--runs <n>` or `STAFF_EVAL_RUNS=<n>` to repeat each selected version/model.
When `n > 1`, the runner writes one sample suite per run and prints aggregate
mean, range, and standard deviation scores. The HTML report shows a collapsible
aggregate card with collapsible per-run sample cards underneath.

Release versions are evaluated from git source tags under
`apps/staffreview/evals/.runs/.staff-sources/`. The fixture installs the skills
from that tag directly and runs that tag's `apps/staffreview/src/cli.ts`, so old
versions do not need to support modern `staff install` flags.

Manual prepare/score subcommands still exist for debugging:

```bash
bun apps/staffreview/evals/cli.ts list
bun apps/staffreview/evals/cli.ts prepare review-quality
bun apps/staffreview/evals/cli.ts score review-quality
```

Non-interactive runs can still pass explicit values:

```bash
bun run eval -- --skills /staff-review --versions current,v1.4.0 --models gpt-5.4-mini,gpt-5.3-codex-spark
bun run eval -- --skills /staff-review --versions current,v1.4.0,v1.3.0 --model gpt-5.4-mini --concurrency 2
bun run eval -- --skills /staff-review --versions current,v1.4.0 --models gpt-5.4-mini --runs 3
```

## Cases

- `review-quality`: `/staff-review` should find P1, P2, and P3 regressions
  across all 10 review areas from the skill taxonomy: correctness, edge cases,
  resources, security, data/migrations, interfaces, tests, consistency,
  maintainability, and performance while avoiding noisy comments.
- `resolve-seeded-comments`: `/staff-resolve` should fix a seeded failing
  invoice bug, reply in-thread, resolve it as fixed, and pass tests.
- `document-request`: `/staff-resolve` should honor `documentRequested`, write a
  docs lesson, reply in-thread, and resolve as documented.
- `loop-end-to-end`: `/staff-loop` should review, resolve, re-review, converge,
  and leave tests passing.
- `section-review`: `/staff-section` should use the whole-tree diff, find an
  issue in existing code, update `section-cache.json`, and avoid source edits.

Scores are intentionally rubric-style rather than pass/fail so model comparisons
can show partial credit and protocol regressions.
