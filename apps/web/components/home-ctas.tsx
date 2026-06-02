'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import posthog from 'posthog-js';

const githubSvg = (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-current">
    <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.21 3.44 9.63 8.21 11.19.6.11.82-.25.82-.57 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.36-1.33-1.73-1.33-1.73-1.09-.73.08-.71.08-.71 1.2.08 1.84 1.21 1.84 1.21 1.07 1.8 2.81 1.28 3.49.98.11-.76.42-1.28.76-1.57-2.67-.3-5.47-1.3-5.47-5.79 0-1.28.47-2.33 1.24-3.15-.13-.3-.54-1.51.11-3.15 0 0 1.01-.32 3.3 1.2.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.29-1.52 3.3-1.2 3.3-1.2.65 1.64.24 2.85.12 3.15.77.82 1.23 1.87 1.23 3.15 0 4.5-2.81 5.49-5.49 5.78.43.36.81 1.08.81 2.18 0 1.58-.01 2.85-.01 3.24 0 .31.21.69.83.57C20.57 21.91 24 17.5 24 12.29 24 5.78 18.63.5 12 .5Z" />
  </svg>
);

interface HeroCtasProps {
  githubUrl: string;
}

export function HeroCtas({ githubUrl }: HeroCtasProps) {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
      <Link
        href="/docs"
        onClick={() => posthog.capture('get_started_clicked', { location: 'hero' })}
        className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90"
      >
        Get started
        <ArrowRight className="size-4" />
      </Link>
      <a
        href={githubUrl}
        target="_blank"
        rel="noreferrer noopener"
        onClick={() => posthog.capture('github_clicked', { location: 'hero' })}
        className="inline-flex items-center gap-2 rounded-lg border border-fd-border px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-fd-muted"
      >
        {githubSvg}
        GitHub
      </a>
    </div>
  );
}

export function ClosingCtas() {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
      <Link
        href="/docs/installation"
        onClick={() => posthog.capture('install_clicked', { location: 'closing_cta' })}
        className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90"
      >
        Install Staff Review
        <ArrowRight className="size-4" />
      </Link>
      <Link
        href="/docs/quickstart"
        onClick={() => posthog.capture('quickstart_clicked', { location: 'closing_cta' })}
        className="inline-flex items-center gap-2 rounded-lg border border-fd-border px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-fd-muted"
      >
        Read the quickstart
      </Link>
    </div>
  );
}
