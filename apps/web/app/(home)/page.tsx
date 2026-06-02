import Image from 'next/image';
import { Bot, Library, Repeat, Search } from 'lucide-react';
import { gitConfig } from '@/lib/shared';
import { HeroCtas, ClosingCtas } from '@/components/home-ctas';

const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

const features = [
  {
    icon: Search,
    title: 'Review any diff, locally, in seconds',
    body: 'Compare a branch, a commit, a range, your staged changes, or your uncommitted working tree — main..WT, <sha>..<sha>, release..main. A clean split/unified diff opens in your browser with inline comments, replies, and resolutions. Catch issues before you push — no GitHub PR required.',
  },
  {
    icon: Bot,
    title: 'A thorough review from any harness or model',
    body: 'Staff Review ships editable skills that drive a staff-engineer-level review: trace every changed hunk through its edge cases, read the callers and tests, and leave concrete, actionable comments. Use Claude Code out of the box, or any agent that can read a SKILL.md and run a shell command.',
  },
  {
    icon: Library,
    title: 'Capture project-specific concerns once',
    body: 'Flag a comment with Document, then run /staff-resolve — the agent writes it up as a library entry. Every future review cross-checks the diff against that library, so the gotcha your team keeps re-learning gets caught automatically. Commit the library and the whole team benefits.',
  },
  {
    icon: Repeat,
    title: 'Loop review → resolve for higher quality',
    body: '/staff-loop runs the review and the fixes in isolated subagents, round after round, until a fresh review finds nothing new (or a cap you set). Each round’s fixes get re-reviewed, so regressions and missed issues surface on their own.',
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-fd-border">
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-60"
          style={{
            background:
              'radial-gradient(ellipse 80% 50% at 50% -10%, color-mix(in oklch, var(--color-fd-primary) 22%, transparent), transparent)',
          }}
        />
        <div className="mx-auto flex max-w-3xl flex-col items-center px-4 py-20 text-center sm:py-28">
          <Image
            src="/icon.png"
            alt="Staff Review"
            width={88}
            height={88}
            className="mb-6 rounded-2xl shadow-sm"
            priority
          />
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
            Staff Review
          </h1>
          <p className="mt-4 text-balance text-lg text-fd-muted-foreground sm:text-xl">
            A local, staff-engineer-grade code review — for your working tree,
            before anyone else sees it.
          </p>
          <p className="mt-4 max-w-2xl text-balance text-fd-muted-foreground">
            Open a GitHub-style review of <em>any</em> diff in your browser and
            let <strong>any AI coding agent</strong> leave a thorough, inline
            review on it — then fix, document, or skip each comment. No PR, no
            cloud, no waiting.
          </p>

          <HeroCtas githubUrl={githubUrl} />

          {/* Terminal snippet */}
          <div className="mt-10 w-full max-w-xl overflow-hidden rounded-xl border border-fd-border bg-fd-card text-left shadow-sm">
            <div className="flex items-center gap-1.5 border-b border-fd-border px-4 py-2.5">
              <span className="size-2.5 rounded-full bg-red-400/80" />
              <span className="size-2.5 rounded-full bg-yellow-400/80" />
              <span className="size-2.5 rounded-full bg-green-400/80" />
            </div>
            <pre className="overflow-x-auto px-4 py-4 text-[13px] leading-relaxed">
              <code>
                <span className="text-fd-muted-foreground">
                  # set up the repo (writes the /staff-* skills)
                </span>
                {'\n'}
                <span className="text-fd-primary">staff</span> install{'\n\n'}
                <span className="text-fd-muted-foreground">
                  # open “main vs. working tree” in your browser
                </span>
                {'\n'}
                <span className="text-fd-primary">staff</span> main..WT{'\n\n'}
                <span className="text-fd-muted-foreground">
                  # then, in your agent:
                </span>
                {'\n'}/staff-review main..WT{'  →  '}/staff-resolve
              </code>
            </pre>
          </div>
        </div>
      </section>

      {/* Why you'll want it */}
      <section className="mx-auto w-full max-w-5xl px-4 py-16 sm:py-20">
        <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
          Why you’ll want it
        </h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {features.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-xl border border-fd-border bg-fd-card p-6 transition-colors hover:bg-fd-accent/40"
            >
              <div className="mb-4 inline-flex size-10 items-center justify-center rounded-lg bg-fd-primary/10 text-fd-primary">
                <Icon className="size-5" />
              </div>
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-fd-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
        <p className="mx-auto mt-8 max-w-2xl text-balance text-center text-sm text-fd-muted-foreground">
          Staff Review itself is <strong>100% local</strong> — a small web
          server reading your local git history. Your agent still talks to
          whatever model you choose; pick a local one if you want zero data to
          leave the machine.
        </p>
      </section>

      {/* Screenshot */}
      <section className="border-t border-fd-border bg-fd-muted/30">
        <div className="mx-auto w-full max-w-5xl px-4 py-16 sm:py-20">
          <div className="overflow-hidden rounded-xl border border-fd-border shadow-sm">
            <Image
              src="/screenshot.png"
              alt="Staff Review — an AI agent’s inline review on a diff, with the comment thread anchored to the changed line and the review sidebar alongside"
              width={1600}
              height={1000}
              className="h-auto w-full"
            />
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="border-t border-fd-border">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-16 text-center sm:py-20">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Do your human reviewers a favor
          </h2>
          <p className="mt-3 max-w-xl text-balance text-fd-muted-foreground">
            Install with Homebrew and open your first review in about a minute.
          </p>
          <ClosingCtas />
        </div>
      </section>
    </main>
  );
}
