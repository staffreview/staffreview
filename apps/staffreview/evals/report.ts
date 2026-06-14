import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { VersionRunResult } from "./runner.ts";
import { commonAncestor, formatNumber, relativeFromCwd } from "./util.ts";

type ReportComment = {
  id: string;
  threadId: string;
  parentId?: string;
  file?: string;
  line?: number;
  endLine?: number;
  body: string;
  author: string;
  priority?: string;
};

type CaseComment = ReportComment & {
  matchedCheck?: string;
  sourcePath?: string;
};

function html(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function percent(score: number, possible: number): number {
  return possible === 0 ? 0 : Math.round((score / possible) * 100);
}

function localHref(path: string): string {
  return pathToFileURL(path).href;
}

function checkClass(earned: number, possible: number): string {
  if (earned === possible) return "pass";
  if (earned === 0) return "fail";
  return "partial";
}

function scoreClass(score: number, possible: number): string {
  const pct = percent(score, possible);
  if (pct >= 90) return "pass";
  if (pct >= 60) return "partial";
  return "fail";
}

function codexFailures(result: VersionRunResult): number {
  return result.codex.filter((item) => item.exitCode !== 0).length;
}

function caseLog(result: VersionRunResult, caseId: string): string | undefined {
  return result.codex.find((item) => item.caseId === caseId)?.log;
}

function commentLocation(comment: ReportComment): string {
  if (!comment.file) return "top-level";
  if (comment.line == null) return comment.file;
  if (comment.endLine && comment.endLine !== comment.line) {
    return `${comment.file}:${comment.line}-${comment.endLine}`;
  }
  return `${comment.file}:${comment.line}`;
}

function matchedCommentPrefixes(checks: VersionRunResult["score"]["cases"][number]["checks"]) {
  return checks
    .map((check) => {
      const match = check.detail.match(/^Matched by ([^\s]+)/);
      return match ? { prefix: match[1]!, check: check.name } : undefined;
    })
    .filter((item): item is { prefix: string; check: string } => item !== undefined);
}

async function loadCaseComments(
  result: VersionRunResult,
  caseId: string,
  checks: VersionRunResult["score"]["cases"][number]["checks"],
): Promise<CaseComment[]> {
  const caseRepo = join(result.suite, caseId);
  const metadata = await readFile(join(caseRepo, "eval-metadata.json"), "utf8")
    .then((text) => JSON.parse(text) as { slug?: string })
    .catch(() => undefined);
  if (!metadata?.slug) return [];
  const diff = await readFile(
    join(caseRepo, ".staffreview", "diffs", `${metadata.slug}.json`),
    "utf8",
  )
    .then((text) => JSON.parse(text) as { comments?: ReportComment[] })
    .catch(() => undefined);
  const prefixes = matchedCommentPrefixes(checks);
  return (diff?.comments ?? [])
    .filter((comment) => !comment.parentId)
    .map((comment) => {
      const matched = prefixes.find((item) => comment.id.startsWith(item.prefix));
      return {
        ...comment,
        matchedCheck: matched?.check,
        sourcePath: comment.file ? join(caseRepo, comment.file) : undefined,
      };
    });
}

function renderSummaryRows(results: VersionRunResult[]): string {
  return results
    .map((result) => {
      const stats = result.stats ?? {
        max: result.score.score,
        mean: result.score.score,
        min: result.score.score,
        possible: result.score.possible,
        runs: 1,
        stdev: 0,
      };
      const pct = percent(stats.mean, result.score.possible);
      return `<tr>
        <td>${html(result.version)}</td>
        <td>${html(result.model)}</td>
        <td>${html(stats.runs)}</td>
        <td><span class="pill ${scoreClass(stats.mean, result.score.possible)}">${html(formatNumber(stats.mean))}/${html(result.score.possible)} (${html(pct)}%)</span></td>
        <td>${html(formatNumber(stats.min))}-${html(formatNumber(stats.max))}</td>
        <td>${html(formatNumber(stats.stdev))}</td>
        <td>${html(codexFailures(result))}</td>
        <td>${html(result.skipped.length)}</td>
        <td><a href="${localHref(result.suite)}">${html(relativeFromCwd(result.suite))}</a></td>
      </tr>`;
    })
    .join("\n");
}

async function renderCaseDetails(
  result: VersionRunResult,
  options: { includeComments?: boolean } = {},
): Promise<string> {
  const includeComments = options.includeComments ?? true;
  const rendered = await Promise.all(
    result.score.cases.map(async (caseResult) => {
      const pct = percent(caseResult.score, caseResult.possible);
      const log = caseLog(result, caseResult.caseId);
      const open = caseResult.score !== caseResult.possible || codexFailures(result) > 0;
      const comments = includeComments
        ? await loadCaseComments(result, caseResult.caseId, caseResult.checks)
        : [];
      const runbookSuite = result.samples?.[0]?.suite ?? result.suite;
      return `<details class="case-details" ${open ? "open" : ""}>
        <summary>
          <span>${html(caseResult.caseId)}</span>
          <span class="pill ${scoreClass(caseResult.score, caseResult.possible)}">${html(formatNumber(caseResult.score))}/${html(caseResult.possible)} (${html(pct)}%)</span>
        </summary>
        <div class="links">
          <a href="${localHref(join(result.suite, result.samples ? "aggregate-result.json" : "eval-result.json"))}">${result.samples ? "aggregate-result.json" : "eval-result.json"}</a>
          ${log ? `<a href="${localHref(log)}">${html(basename(log))}</a>` : ""}
          <a href="${localHref(join(runbookSuite, caseResult.caseId, "RUN.md"))}">runbook</a>
        </div>
        <table>
          <thead>
            <tr>
              <th>Check</th>
              <th>Score</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            ${caseResult.checks
              .map(
                (check) => `<tr>
                  <td>${html(check.name)}</td>
                  <td><span class="pill ${checkClass(check.earned, check.possible)}">${html(formatNumber(check.earned))}/${html(check.possible)}</span></td>
                  <td>${html(check.detail)}</td>
                </tr>`,
              )
              .join("\n")}
          </tbody>
        </table>
        ${renderComments(comments)}
      </details>`;
    }),
  );
  return rendered.join("\n");
}

function renderComments(comments: CaseComment[]): string {
  if (comments.length === 0) return "";
  return `<h3>Review Comments</h3>
    <div class="comments">
      ${comments
        .map((comment) => {
          const matched = Boolean(comment.matchedCheck);
          return `<article id="comment-${html(comment.id)}" class="comment ${matched ? "matched" : "unmatched"}">
            <div class="comment-meta">
              <span class="pill ${matched ? "pass" : "fail"}">${matched ? "matched" : "unmatched"}</span>
              <span>${html(comment.priority ?? "no priority")}</span>
              <span>${html(comment.author)}</span>
              ${
                comment.sourcePath
                  ? `<a href="${localHref(comment.sourcePath)}">${html(commentLocation(comment))}</a>`
                  : `<span>${html(commentLocation(comment))}</span>`
              }
              ${comment.matchedCheck ? `<span>${html(comment.matchedCheck)}</span>` : "<span>noise candidate</span>"}
            </div>
            <div class="comment-body">${html(comment.body)}</div>
            <div class="links">
              <a href="#comment-${html(comment.id)}">${html(comment.id.slice(0, 8))}</a>
            </div>
          </article>`;
        })
        .join("\n")}
    </div>`;
}

async function renderResultSection(
  result: VersionRunResult,
  options: { nested?: boolean } = {},
): Promise<string> {
  const stats = result.stats ?? {
    max: result.score.score,
    mean: result.score.score,
    min: result.score.score,
    possible: result.score.possible,
    runs: 1,
    stdev: 0,
  };
  const pct = percent(stats.mean, result.score.possible);
  const skipped = result.skipped
    .map(
      (item) =>
        `<li><strong>${html(item.caseId)}</strong>: ${html(item.reason)} (${html(item.skill)})</li>`,
    )
    .join("\n");
  const failures = result.codex
    .filter((item) => item.exitCode !== 0)
    .map(
      (item) =>
        `<li><strong>${html(item.caseId)}</strong>: exit ${html(item.exitCode)} - <a href="${localHref(item.log)}">${html(basename(item.log))}</a></li>`,
    )
    .join("\n");
  const samples = result.samples
    ? (
        await Promise.all(
          result.samples.map((sample) => renderResultSection(sample, { nested: true })),
        )
      ).join("\n")
    : "";
  const resultJson = result.samples ? "aggregate-result.json" : "eval-result.json";
  const title = result.samples
    ? `${result.version} ${result.model} aggregate`
    : `${result.version} ${result.model}${result.repeatIndex ? ` run ${result.repeatIndex}` : ""}`;
  return `<details class="result-card ${options.nested ? "sample-card" : ""}" ${options.nested ? "" : "open"}>
    <summary class="result-summary">
      <span>${html(title)}</span>
      <span class="pill ${scoreClass(stats.mean, result.score.possible)}">${html(formatNumber(stats.mean))}/${html(result.score.possible)} (${html(pct)}%)</span>
    </summary>
    <div class="scoreline">
      <span>${html(stats.runs)} run${stats.runs === 1 ? "" : "s"}</span>
      ${
        stats.runs > 1
          ? `<span>range ${html(formatNumber(stats.min))}-${html(formatNumber(stats.max))}</span><span>stdev ${html(formatNumber(stats.stdev))}</span>`
          : ""
      }
      <a href="${localHref(result.suite)}">suite</a>
      <a href="${localHref(join(result.suite, resultJson))}">${html(resultJson)}</a>
    </div>
    ${failures ? `<h3>Codex Failures</h3><ul>${failures}</ul>` : ""}
    ${skipped ? `<h3>Skipped Cases</h3><ul>${skipped}</ul>` : ""}
    ${await renderCaseDetails(result, { includeComments: !result.samples })}
    ${samples ? `<h3>Individual Runs</h3><div class="sample-list">${samples}</div>` : ""}
  </details>`;
}

async function renderResultSections(results: VersionRunResult[]): Promise<string> {
  const rendered = await Promise.all(results.map((result) => renderResultSection(result)));
  return rendered.join("\n");
}

async function renderReport(results: VersionRunResult[]): Promise<string> {
  const generatedAt = new Date().toLocaleString();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Staff Review Eval Report</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f7f8fa;
        --panel: #ffffff;
        --panel-sunken: #f1f3f7;
        --text: #16181d;
        --muted: #626975;
        --border: #d9dee7;
        --hover: rgba(16, 24, 40, 0.05);
        --pass-bg: #e6f6ec;
        --pass-text: #136c33;
        --partial-bg: #fff4d8;
        --partial-text: #825600;
        --fail-bg: #fde8e8;
        --fail-text: #9b1c1c;
        --link: #155ec2;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #111318;
          --panel: #191c22;
          --panel-sunken: #14161b;
          --text: #f2f4f8;
          --muted: #a6adbb;
          --border: #303642;
          --hover: rgba(255, 255, 255, 0.06);
          --pass-bg: #12351f;
          --pass-text: #8ee3a3;
          --partial-bg: #3a2b09;
          --partial-text: #ffd36a;
          --fail-bg: #421c1c;
          --fail-text: #ff9f9f;
          --link: #8ab4ff;
        }
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 28px;
      }
      header {
        margin-bottom: 24px;
      }
      h1 {
        margin: 0 0 4px;
        font-size: 28px;
      }
      h2 {
        display: flex;
        gap: 10px;
        align-items: baseline;
        margin: 0 0 10px;
        font-size: 20px;
      }
      h2 span,
      .muted {
        color: var(--muted);
        font-size: 13px;
        font-weight: 500;
      }
      h3 {
        margin: 18px 0 6px;
        font-size: 15px;
      }
      section,
      .summary {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        margin: 16px 0;
        padding: 18px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        border-bottom: 1px solid var(--border);
        padding: 9px 8px;
        text-align: left;
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
      }
      tr:last-child td {
        border-bottom: 0;
      }
      a {
        color: var(--link);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      .result-card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        margin: 16px 0;
        padding: 16px 18px;
      }
      .result-card.sample-card {
        background: var(--panel-sunken);
        margin: 10px 0;
        padding: 12px 14px;
      }
      .case-details {
        border-top: 1px solid var(--border);
        margin-top: 12px;
        padding-top: 8px;
      }
      .case-details:first-of-type {
        margin-top: 16px;
      }
      summary {
        align-items: center;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        gap: 8px;
        list-style: none;
        margin: 0 -6px;
        padding: 4px 6px;
        user-select: none;
      }
      /* Hide the native disclosure triangle in favour of the chevron below. */
      summary::-webkit-details-marker {
        display: none;
      }
      summary:hover {
        background: var(--hover);
      }
      /* Rotating chevron: points right when collapsed, down when open. */
      summary::before {
        color: var(--muted);
        content: "›";
        flex: 0 0 auto;
        font-size: 18px;
        line-height: 1;
        text-align: center;
        transition: transform 0.15s ease;
        width: 12px;
      }
      details[open] > summary::before {
        transform: rotate(90deg);
      }
      /* Push the score pill to the right edge without justify-content, so the
         chevron and title stay tucked together on the left. */
      summary > .pill {
        margin-left: auto;
      }
      .result-summary {
        font-size: 18px;
        font-weight: 700;
      }
      .sample-card .result-summary {
        font-size: 15px;
      }
      .scoreline,
      .links {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin: 8px 0 12px;
      }
      .pill {
        border-radius: 999px;
        display: inline-block;
        font-variant-numeric: tabular-nums;
        font-weight: 700;
        min-width: 70px;
        padding: 2px 8px;
        text-align: center;
      }
      .comments {
        display: grid;
        gap: 10px;
        margin-top: 8px;
      }
      .sample-list {
        display: grid;
        gap: 8px;
      }
      .comment {
        border: 1px solid var(--border);
        border-left-width: 4px;
        border-radius: 8px;
        padding: 10px;
      }
      .comment.matched {
        border-left-color: var(--pass-text);
      }
      .comment.unmatched {
        border-left-color: var(--fail-text);
      }
      .comment-meta {
        align-items: center;
        color: var(--muted);
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 8px;
      }
      .comment-body {
        white-space: pre-wrap;
      }
      .pass {
        background: var(--pass-bg);
        color: var(--pass-text);
      }
      .partial {
        background: var(--partial-bg);
        color: var(--partial-text);
      }
      .fail {
        background: var(--fail-bg);
        color: var(--fail-text);
      }
      ul {
        margin: 6px 0 0 20px;
        padding: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Staff Review Eval Report</h1>
        <div class="muted">Generated ${html(generatedAt)}</div>
      </header>
      <div class="summary">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Model</th>
              <th>Runs</th>
              <th>Score</th>
              <th>Range</th>
              <th>Stdev</th>
              <th>Failures</th>
              <th>Skipped</th>
              <th>Suite</th>
            </tr>
          </thead>
          <tbody>
            ${renderSummaryRows(results)}
          </tbody>
        </table>
      </div>
      ${await renderResultSections(results)}
    </main>
  </body>
</html>
`;
}

export async function writeHtmlReport(results: VersionRunResult[]): Promise<string> {
  const reportRoot = commonAncestor(results.map((result) => result.suite));
  await mkdir(reportRoot, { recursive: true });
  const reportPath = join(reportRoot, "report.html");
  await writeFile(reportPath, await renderReport(results));
  return reportPath;
}

export async function openHtmlReport(reportPath: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", reportPath]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", reportPath]
        : ["xdg-open", reportPath];
  const proc = Bun.spawn(command, {
    stderr: "pipe",
    stdout: "ignore",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `${command[0]} exited with ${exitCode}`);
  }
}
