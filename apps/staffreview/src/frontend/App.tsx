import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronsUpDown,
  Columns2,
  FoldVertical,
  Loader2,
  MessageSquarePlus,
  Minus,
  Monitor,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Rows2,
  Settings,
  Sun,
  UnfoldVertical,
  X,
} from "lucide-react";
import type { Diff, DiffTarget, FileDiff, GitRefInfo } from "../types.ts";
import logoUrl from "./logo.png";
import { DEFAULT_LOOP_ROUNDS, MIN_LOOP_ROUNDS, MAX_LOOP_ROUNDS } from "../loop-config.ts";
import { api, openSocket, type ColorScheme, type WSEvent } from "./lib/api.ts";
import {
  DARK_SYNTAX_THEMES,
  LIGHT_SYNTAX_THEMES,
  ensureShikiTheme,
} from "./lib/highlight.ts";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.tsx";
import { cn } from "./lib/utils.ts";
import { Button } from "./components/ui/button.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { TargetPicker } from "./components/TargetPicker.tsx";
import { DiffView } from "./components/DiffView.tsx";
import { TopLevelComments } from "./components/TopLevelComments.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group.tsx";

function parseSlug(slug: string): { base: DiffTarget; head: DiffTarget } | null {
  const sep = slug.indexOf("..");
  if (sep < 0) return null;
  const left = slug.slice(0, sep);
  const right = slug.slice(sep + 2);
  const toTarget = (part: string): DiffTarget => {
    if (part === "WT") return { kind: "working-tree" };
    if (part === "STAGED") return { kind: "staged" };
    return { kind: "ref", ref: part };
  };
  return { base: toTarget(left), head: toTarget(right) };
}

function defaultTargets(
  branch: string | null,
  refs: GitRefInfo[],
): { base: DiffTarget; head: DiffTarget } {
  // Pin the default base to the current branch's commit so the slug doesn't
  // silently follow a moving branch — see the same-named user request that
  // motivated the SHA-pinned picker.
  const branchRef = branch
    ? refs.find((r) => r.kind === "branch" && r.name === branch)
    : undefined;
  return {
    base: branchRef?.sha
      ? { kind: "commit", ref: branchRef.sha, label: branchRef.name }
      : branch
        ? { kind: "ref", ref: branch }
        : { kind: "ref", ref: "HEAD" },
    head: { kind: "working-tree" },
  };
}

export function App() {
  const [info, setInfo] = useState<{ cwd: string; root: string; branch: string | null } | null>(null);
  const [refs, setRefs] = useState<GitRefInfo[]>([]);
  const [base, setBase] = useState<DiffTarget>({ kind: "ref", ref: "HEAD" });
  const [head, setHead] = useState<DiffTarget>({ kind: "working-tree" });
  const [diff, setDiff] = useState<Diff | null>(null);
  const [files, setFiles] = useState<FileDiff[]>([]);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [splitView, setSplitViewState] = useState(true);
  const DEFAULT_DIFF_FONT_SIZE = 14;
  const MIN_DIFF_FONT_SIZE = 9;
  const MAX_DIFF_FONT_SIZE = 22;
  const [diffFontSize, setDiffFontSizeState] = useState<number>(DEFAULT_DIFF_FONT_SIZE);
  const [theme, setThemeState] = useState<ColorScheme>("system");
  const [effectiveTheme, setEffectiveTheme] = useState<"light" | "dark">("light");
  const [syntaxThemeLight, setSyntaxThemeLightState] = useState<string>("catppuccin-latte");
  const [syntaxThemeDark, setSyntaxThemeDarkState] = useState<string>("catppuccin-mocha");
  const [syntaxPickerOpen, setSyntaxPickerOpen] = useState(false);
  // Collapsed by default (showDiffOnly): only the changed hunks show,
  // with react-diff-viewer's expand/fold-all controls to reveal the rest.
  // Switch to "Expanded" in the gear menu to always show whole files.
  const [filesExpandedByDefault, setFilesExpandedByDefaultState] = useState(false);
  // Hard cap on review→resolve rounds for the /staff-loop skill. Default and
  // bounds come from loop-config.ts, shared with the server (settings.ts).
  const [loopMaxRounds, setLoopMaxRoundsState] = useState<number>(DEFAULT_LOOP_ROUNDS);
  // Load preferences from the global settings file at startup, then
  // persist any user-driven change through the server so they survive
  // ports and projects.
  useEffect(() => {
    (async () => {
      try {
        const { settings } = await api.settings();
        if (typeof settings.splitView === "boolean") setSplitViewState(settings.splitView);
        if (typeof settings.diffFontSize === "number") {
          setDiffFontSizeState(
            Math.min(MAX_DIFF_FONT_SIZE, Math.max(MIN_DIFF_FONT_SIZE, settings.diffFontSize)),
          );
        }
        if (
          settings.theme === "system" ||
          settings.theme === "light" ||
          settings.theme === "dark"
        ) {
          setThemeState(settings.theme);
        }
        if (typeof settings.syntaxThemeLight === "string") {
          setSyntaxThemeLightState(settings.syntaxThemeLight);
          ensureShikiTheme(settings.syntaxThemeLight).catch(() => {});
        }
        if (typeof settings.syntaxThemeDark === "string") {
          setSyntaxThemeDarkState(settings.syntaxThemeDark);
          ensureShikiTheme(settings.syntaxThemeDark).catch(() => {});
        }
        if (typeof settings.filesExpandedByDefault === "boolean") {
          setFilesExpandedByDefaultState(settings.filesExpandedByDefault);
        }
        if (typeof settings.loopMaxRounds === "number") {
          setLoopMaxRoundsState(
            Math.min(MAX_LOOP_ROUNDS, Math.max(MIN_LOOP_ROUNDS, settings.loopMaxRounds)),
          );
        }
      } catch {}
    })();
  }, []);
  const setSplitView = useCallback((next: boolean) => {
    setSplitViewState(next);
    api.setSettings({ splitView: next }).catch(() => {});
  }, []);
  const setDiffFontSize = useCallback((next: number) => {
    const clamped = Math.min(MAX_DIFF_FONT_SIZE, Math.max(MIN_DIFF_FONT_SIZE, next));
    setDiffFontSizeState(clamped);
    api.setSettings({ diffFontSize: clamped }).catch(() => {});
  }, []);
  const setTheme = useCallback((next: ColorScheme) => {
    setThemeState(next);
    api.setSettings({ theme: next }).catch(() => {});
  }, []);
  const setFilesExpandedByDefault = useCallback((next: boolean) => {
    setFilesExpandedByDefaultState(next);
    api.setSettings({ filesExpandedByDefault: next }).catch(() => {});
  }, []);
  const setLoopMaxRounds = useCallback((next: number) => {
    const clamped = Math.min(MAX_LOOP_ROUNDS, Math.max(MIN_LOOP_ROUNDS, next));
    setLoopMaxRoundsState(clamped);
    api.setSettings({ loopMaxRounds: clamped }).catch(() => {});
  }, []);
  const setSyntaxTheme = useCallback(
    async (mode: "light" | "dark", name: string) => {
      try {
        await ensureShikiTheme(name);
      } catch {}
      if (mode === "light") {
        setSyntaxThemeLightState(name);
        api.setSettings({ syntaxThemeLight: name }).catch(() => {});
      } else {
        setSyntaxThemeDarkState(name);
        api.setSettings({ syntaxThemeDark: name }).catch(() => {});
      }
    },
    [],
  );

  // Reflect the active theme on <html>. For "system", track the OS
  // preference live so the page flips with the OS without a reload.
  // Also keep `effectiveTheme` in sync so children (DiffView/Shiki) can
  // pick the right syntax theme.
  useEffect(() => {
    const root = document.documentElement;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const wantDark = theme === "dark" || (theme === "system" && mql.matches);
      root.classList.toggle("dark", wantDark);
      root.dataset.theme = theme;
      setEffectiveTheme(wantDark ? "dark" : "light");
    };
    apply();
    if (theme === "system") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
  }, [theme]);
  const [wsHello, setWsHello] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugCopied, setSlugCopied] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("staff:sidebar") !== "closed";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("staff:sidebar", sidebarOpen ? "open" : "closed");
    } catch {}
  }, [sidebarOpen]);
  const [composing, setComposing] = useState(false);

  // Hold the current slug in a ref so the WS handler can read it without
  // having to be torn down and recreated on every diff change.
  const slugRef = useRef<string | null>(null);
  useEffect(() => {
    slugRef.current = diff?.slug ?? null;
  }, [diff?.slug]);

  useEffect(() => {
    (async () => {
      try {
        const i = await api.info();
        const r = await api.refs();

        // Resolve which (base, head) we want BEFORE flipping `info`, so the
        // reload effect (which keys on `info`) only fires once with the final
        // targets rather than racing through HEAD → WT → final.
        let chosenBase: DiffTarget | null = null;
        let chosenHead: DiffTarget | null = null;

        // 1) URL ?diff=<slug> wins — that's the shareable link path.
        const urlSlug = new URLSearchParams(window.location.search).get("diff");
        if (urlSlug) {
          try {
            const { diff: shared } = await api.diff(urlSlug);
            chosenBase = shared.base;
            chosenHead = shared.head;
          } catch {
            // Fall back to parsing the slug into targets — works when the
            // recipient doesn't have the diff JSON yet but has the same
            // branches/working tree available.
            const parsed = parseSlug(urlSlug);
            if (parsed) {
              chosenBase = parsed.base;
              chosenHead = parsed.head;
            }
          }
        }

        // 2) Restore the last active diff (persisted in .staffreview/active.json).
        if (!chosenBase) {
          const active = await api.active();
          if (active.slug) {
            const list = await api.diffs();
            const found = list.diffs.find((d) => d.slug === active.slug);
            if (found) {
              chosenBase = found.base;
              chosenHead = found.head;
            }
          }
        }

        // 3) Defaults.
        if (!chosenBase) {
          const def = defaultTargets(i.branch, r.refs);
          chosenBase = def.base;
          chosenHead = def.head;
        }

        setRefs(r.refs);
        setBase(chosenBase);
        setHead(chosenHead!);
        // setInfo last — it gates the reload effect, so no early HEAD..WT
        // round-trip pollutes active.json.
        setInfo(i);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  // Keep `?diff=<slug>` in the URL in sync with the active diff so the
  // address bar is shareable.
  useEffect(() => {
    if (!diff?.slug) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("diff") === diff.slug) return;
    url.searchParams.set("diff", diff.slug);
    window.history.replaceState({}, "", url.toString());
  }, [diff?.slug]);

  // Re-fetch the file diff without the loading spinner — used when the
  // working tree changes under us (so an edit in the editor shows up in
  // the diff without a manual Refresh). Defined here, above the effects
  // that depend on it. No-ops unless the diff actually involves the
  // working tree or index — a static commit↔commit diff can't change from
  // a file edit, so there's nothing to refresh.
  const reloadFilesQuiet = useCallback(async () => {
    if (!info) return;
    const dynamic =
      base.kind === "working-tree" || base.kind === "staged" ||
      head.kind === "working-tree" || head.kind === "staged";
    if (!dynamic) return;
    try {
      const filesResp = await api.files(base, head);
      setFiles(filesResp.files);
    } catch {}
  }, [base, head, info]);

  // Periodically refresh the refs list so we can detect when the branch
  // our base (or head) is pinned to advances past the SHA we've locked.
  useEffect(() => {
    if (!info) return;
    const tick = async () => {
      try {
        const r = await api.refs();
        setRefs(r.refs);
      } catch {}
    };
    const id = window.setInterval(tick, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        tick();
        // Also pull fresh file changes when returning to the tab, in case
        // a working-tree edit happened while it was hidden.
        reloadFilesQuiet();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [info, reloadFilesQuiet]);

  // Detect when base is pinned to a now-stale commit on a moving
  // branch/tag — surface a banner so the user can fast-forward. Only
  // applies to base; picking a specific commit for head is an intentional
  // act (otherwise you'd be targeting WT), so we don't second-guess it.
  const staleBaseRaw = useMemo(() => {
    if (!base || base.kind !== "commit" || !base.label) return null;
    const r = refs.find(
      (x) =>
        (x.kind === "branch" || x.kind === "remote" || x.kind === "tag") &&
        x.name === base.label,
    );
    if (!r?.sha || r.sha === base.ref) return null;
    return { branch: base.label, latestSha: r.sha };
  }, [base, refs]);
  // Track which SHA the user has dismissed so the banner stays hidden
  // until either the user picks a fresh base or a *newer* commit lands.
  const [staleDismissedSha, setStaleDismissedSha] = useState<string | null>(null);
  const staleBase =
    staleBaseRaw && staleBaseRaw.latestSha !== staleDismissedSha ? staleBaseRaw : null;

  const reload = useCallback(async () => {
    if (!info) return;
    setLoadingDiff(true);
    setError(null);
    try {
      const [filesResp, diffResp] = await Promise.all([
        api.files(base, head),
        api.createDiff(base, head),
      ]);
      setFiles(filesResp.files);
      slugRef.current = diffResp.diff.slug;
      setDiff(diffResp.diff);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingDiff(false);
    }
  }, [base, head, info]);

  useEffect(() => {
    reload();
  }, [reload]);

  const refreshDiffOnly = useCallback(async (slug?: string) => {
    const targetSlug = slug ?? slugRef.current;
    if (!targetSlug) return;
    const d = await api.diff(targetSlug);
    setDiff(d.diff);
  }, []);

  useEffect(() => {
    const close = openSocket((ev: WSEvent) => {
      if (ev.type === "hello") {
        setWsHello(true);
        return;
      }
      if (ev.type === "disconnected") {
        setWsHello(false);
        return;
      }
      if (
        ev.type === "comment:added" ||
        ev.type === "comment:deleted" ||
        ev.type === "thread:resolved" ||
        ev.type === "thread:unresolved"
      ) {
        if (slugRef.current && ev.slug === slugRef.current) {
          refreshDiffOnly();
        }
        return;
      }
      if (ev.type === "diff:changed") {
        refreshDiffOnly();
        return;
      }
      // The working tree changed (a source file was edited) — re-fetch
      // the file diff so the change shows without a manual Refresh.
      if (ev.type === "repo:changed") {
        reloadFilesQuiet();
      }
    });
    return close;
  }, [refreshDiffOnly, reloadFilesQuiet]);

  const comments = diff?.comments ?? [];
  const fileComments = useMemo(() => comments.filter((c) => c.file), [comments]);

  return (
    <div
      // On desktop the page is a fixed-height column (header + two panes) that
      // doesn't scroll itself — the diff and the sidebar each scroll
      // independently (see <main>), so the diff's scrollbar sits between the
      // two panes and the sidebar gets its own on the right. On mobile it falls
      // back to a normal scrolling page.
      className="min-h-full lg:h-full flex flex-col lg:overflow-hidden"
      style={{ "--staff-diff-font-size": `${diffFontSize}px` } as React.CSSProperties}
    >
      <header className="shrink-0 sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="w-full px-4 lg:pr-2.5 pt-3 pb-2 flex items-center gap-3 overflow-x-auto">
          <img
            src={logoUrl}
            alt="Staff Review"
            width={28}
            height={28}
            className="h-7 w-7 shrink-0"
          />
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-mono font-semibold truncate" title={info?.root}>
              {info?.root}
            </div>
            {info?.branch && (
              <Badge className="font-mono shrink-0">{info.branch}</Badge>
            )}
          </div>

          <div className="h-6 w-px bg-border mx-1" />

          <TargetPicker
            label="base"
            value={base}
            refs={refs}
            onChange={setBase}
            includeWorkingState={false}
          />
          <TargetPicker label="head" value={head} refs={refs} onChange={setHead} />

          {diff && (
            <Badge
              asChild
              variant="secondary"
              className="cursor-pointer select-none shrink-0"
            >
              <button
                type="button"
                title={slugCopied ? "Slug copied" : "Click to copy slug"}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(diff.slug);
                    setSlugCopied(true);
                    window.setTimeout(() => setSlugCopied(false), 1200);
                  } catch {}
                }}
                data-testid="diff-slug"
                className="font-mono flex items-center gap-1"
              >
                <span data-testid="diff-slug-text">{diff.slug}</span>
                {slugCopied && (
                  <Check
                    className="h-3 w-3 text-success"
                    data-testid="diff-slug-copied"
                  />
                )}
              </button>
            </Badge>
          )}

          <div className="flex-1" />

          <Badge variant={wsHello ? "success" : "muted"}>{wsHello ? "Live" : "Connecting…"}</Badge>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Settings"
                data-testid="settings-menu-button"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Diff</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => reload()}
                disabled={loadingDiff}
                data-testid="settings-menu-refresh"
              >
                {loadingDiff ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Refresh
              </DropdownMenuItem>
              <DropdownMenuLabel>View mode</DropdownMenuLabel>
              <div className="px-2 py-1">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={splitView ? "split" : "unified"}
                  onValueChange={(v) => {
                    if (v) setSplitView(v === "split");
                  }}
                  aria-label="Diff view mode"
                  className="w-full"
                >
                  <ToggleGroupItem value="split" className="flex-1" data-testid="view-mode-split">
                    <Columns2 className="h-3.5 w-3.5" />
                    Split
                  </ToggleGroupItem>
                  <ToggleGroupItem value="unified" className="flex-1" data-testid="view-mode-unified">
                    <Rows2 className="h-3.5 w-3.5" />
                    Unified
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <DropdownMenuLabel>Files</DropdownMenuLabel>
              <div className="px-2 py-1">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={filesExpandedByDefault ? "expanded" : "collapsed"}
                  onValueChange={(v) => {
                    if (v) setFilesExpandedByDefault(v === "expanded");
                  }}
                  aria-label="Default file expansion"
                  className="w-full"
                >
                  <ToggleGroupItem value="expanded" className="flex-1" data-testid="files-default-expanded">
                    <UnfoldVertical className="h-3.5 w-3.5" />
                    Expanded
                  </ToggleGroupItem>
                  <ToggleGroupItem value="collapsed" className="flex-1" data-testid="files-default-collapsed">
                    <FoldVertical className="h-3.5 w-3.5" />
                    Collapsed
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <DropdownMenuLabel>Font size</DropdownMenuLabel>
              <div className="px-2 py-1 flex items-center gap-2">
                <div className="inline-flex h-8 items-center rounded-md border border-input bg-background shadow-xs">
                  <button
                    type="button"
                    aria-label="Decrease diff font size"
                    title="Decrease"
                    onClick={() => setDiffFontSize(diffFontSize - 1)}
                    disabled={diffFontSize <= MIN_DIFF_FONT_SIZE}
                    data-testid="diff-font-decrease"
                    className={cn(
                      "inline-flex h-full w-8 items-center justify-center rounded-l-md",
                      "transition-colors hover:bg-accent hover:text-accent-foreground",
                      "disabled:pointer-events-none disabled:opacity-40",
                    )}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <div className="border-l border-input" />
                  <button
                    type="button"
                    aria-label="Increase diff font size"
                    title="Increase"
                    onClick={() => setDiffFontSize(diffFontSize + 1)}
                    disabled={diffFontSize >= MAX_DIFF_FONT_SIZE}
                    data-testid="diff-font-increase"
                    className={cn(
                      "inline-flex h-full w-8 items-center justify-center rounded-r-md",
                      "transition-colors hover:bg-accent hover:text-accent-foreground",
                      "disabled:pointer-events-none disabled:opacity-40",
                    )}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <span className="text-xs font-mono text-muted-foreground" data-testid="diff-font-size">
                  {diffFontSize}px
                </span>
              </div>
              <DropdownMenuLabel>Theme</DropdownMenuLabel>
              <div className="px-2 py-1">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={theme}
                  onValueChange={(v) => {
                    if (v === "system" || v === "light" || v === "dark") setTheme(v);
                  }}
                  aria-label="Color scheme"
                  className="w-full"
                >
                  <ToggleGroupItem value="system" className="flex-1" data-testid="theme-system">
                    <Monitor className="h-3.5 w-3.5" />
                    System
                  </ToggleGroupItem>
                  <ToggleGroupItem value="light" className="flex-1" data-testid="theme-light">
                    <Sun className="h-3.5 w-3.5" />
                    Light
                  </ToggleGroupItem>
                  <ToggleGroupItem value="dark" className="flex-1" data-testid="theme-dark">
                    <Moon className="h-3.5 w-3.5" />
                    Dark
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <DropdownMenuLabel>Syntax theme</DropdownMenuLabel>
              {(() => {
                const list = effectiveTheme === "dark" ? DARK_SYNTAX_THEMES : LIGHT_SYNTAX_THEMES;
                const current = effectiveTheme === "dark" ? syntaxThemeDark : syntaxThemeLight;
                return (
                  <div className="px-2 py-1">
                    <Popover open={syntaxPickerOpen} onOpenChange={setSyntaxPickerOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          role="combobox"
                          aria-expanded={syntaxPickerOpen}
                          className="w-full justify-between font-mono text-xs"
                          data-testid="syntax-theme-button"
                        >
                          <span className="truncate">{current}</span>
                          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 opacity-50 shrink-0" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-[260px] p-0"
                        align="start"
                        // The picker lives inside a DropdownMenu — stop
                        // key events from bubbling up to its built-in
                        // first-letter typeahead so the user can type
                        // into the search input.
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <Command>
                          <CommandInput
                            placeholder="Search themes…"
                            data-testid="syntax-theme-search"
                            className="h-8"
                          />
                          <CommandList className="max-h-64">
                            <CommandEmpty>No theme found.</CommandEmpty>
                            <CommandGroup>
                              {list.map((t) => (
                                <CommandItem
                                  key={t}
                                  value={t}
                                  onSelect={() => {
                                    setSyntaxTheme(effectiveTheme, t);
                                    setSyntaxPickerOpen(false);
                                  }}
                                  data-testid={`syntax-theme-${t}`}
                                >
                                  <Check
                                    className={cn(
                                      "h-3.5 w-3.5",
                                      current === t ? "opacity-100" : "opacity-0",
                                    )}
                                  />
                                  <span className="font-mono text-xs">{t}</span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                );
              })()}
              <DropdownMenuLabel>Review loop</DropdownMenuLabel>
              <div className="px-2 py-1 flex items-center gap-2">
                <div className="inline-flex h-8 items-center rounded-md border border-input bg-background shadow-xs">
                  <button
                    type="button"
                    aria-label="Decrease /staff-loop round cap"
                    title="Fewer rounds"
                    onClick={() => setLoopMaxRounds(loopMaxRounds - 1)}
                    disabled={loopMaxRounds <= MIN_LOOP_ROUNDS}
                    data-testid="loop-rounds-decrease"
                    className={cn(
                      "inline-flex h-full w-8 items-center justify-center rounded-l-md",
                      "transition-colors hover:bg-accent hover:text-accent-foreground",
                      "disabled:pointer-events-none disabled:opacity-40",
                    )}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <div className="border-l border-input" />
                  <button
                    type="button"
                    aria-label="Increase /staff-loop round cap"
                    title="More rounds"
                    onClick={() => setLoopMaxRounds(loopMaxRounds + 1)}
                    disabled={loopMaxRounds >= MAX_LOOP_ROUNDS}
                    data-testid="loop-rounds-increase"
                    className={cn(
                      "inline-flex h-full w-8 items-center justify-center rounded-r-md",
                      "transition-colors hover:bg-accent hover:text-accent-foreground",
                      "disabled:pointer-events-none disabled:opacity-40",
                    )}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <span className="text-xs text-muted-foreground" data-testid="loop-rounds-value">
                  {loopMaxRounds} {loopMaxRounds === 1 ? "round" : "rounds"} max
                </span>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main
        className={cn(
          // pr-2.5 on desktop so the sidebar's scrollbar has the same 10px to
          // the screen edge as it does to the sidebar content (matching the
          // diff scrollbar's even spacing).
          "w-full px-4 pt-2 pb-5 lg:pr-2.5 grid grid-cols-1 gap-5 flex-1",
          // Desktop: clip <main> and size the single row to the available
          // height so each pane below can own its own scrollbar. The column
          // gap is moved onto the diff pane (pr + mr below) so the diff's
          // scrollbar sits with equal space on either side.
          "lg:min-h-0 lg:overflow-hidden lg:gap-0 lg:grid-rows-[minmax(0,1fr)]",
          sidebarOpen ? "lg:grid-cols-[1fr_360px]" : "lg:grid-cols-[1fr_32px]",
        )}
      >
        <div
          className="space-y-6 min-w-0 lg:min-h-0 lg:overflow-y-auto lg:pr-2.5 lg:mr-2.5"
          data-testid="diff-scroll"
        >
          {error && (
            <div className="rounded-md border border-destructive bg-destructive/10 text-destructive px-3 py-2 text-sm">
              {error}
            </div>
          )}
          {loadingDiff ? (
            <div className="grid place-items-center h-40">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : diff ? (
            <DiffView
              files={files}
              slug={diff.slug}
              comments={fileComments}
              splitView={splitView}
              themeMode={effectiveTheme}
              syntaxTheme={effectiveTheme === "dark" ? syntaxThemeDark : syntaxThemeLight}
              expandedByDefault={filesExpandedByDefault}
              onChange={refreshDiffOnly}
            />
          ) : null}
        </div>

        <aside
          data-testid="review-sidebar"
          data-state={sidebarOpen ? "open" : "collapsed"}
          // Desktop: its own scroll pane, so a long thread list scrolls here
          // (scrollbar on the right) instead of scrolling the whole page.
          className={cn(
            "lg:min-h-0",
            // pr-2.5 keeps the thread list off its own scrollbar (matches the
            // diff pane's right padding).
            sidebarOpen ? "space-y-5 lg:overflow-y-auto lg:pr-2.5" : "flex flex-col items-end gap-2",
          )}
        >
          {sidebarOpen
            ? diff && (
                <TopLevelComments
                  slug={diff.slug}
                  comments={comments}
                  files={files}
                  onChange={refreshDiffOnly}
                  composing={composing}
                  onComposingChange={setComposing}
                  headerLeft={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Hide review sidebar"
                      aria-pressed="false"
                      title="Hide review sidebar"
                      onClick={() => setSidebarOpen(false)}
                      data-testid="sidebar-toggle"
                    >
                      <PanelRightClose className="h-4 w-4" />
                    </Button>
                  }
                />
              )
            : (
              <>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Show review sidebar"
                  aria-pressed="true"
                  title="Show review sidebar"
                  onClick={() => setSidebarOpen(true)}
                  data-testid="sidebar-toggle"
                >
                  <PanelRightOpen className="h-4 w-4" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="New comment"
                  title="New comment"
                  onClick={() => {
                    setSidebarOpen(true);
                    setComposing(true);
                  }}
                  data-testid="sidebar-new-comment"
                >
                  <MessageSquarePlus className="h-4 w-4" />
                </Button>
              </>
            )}
        </aside>
      </main>

      {staleBase && (
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 rounded-md border border-border bg-background/95 backdrop-blur shadow-lg px-4 py-2 flex items-center gap-3 text-sm"
          data-testid="stale-target-banner"
        >
          <span className="flex items-center gap-1.5">
            <code className="font-mono font-semibold">{staleBase.branch}</code>
            <span className="text-muted-foreground">has new commits ·</span>
            <code className="font-mono text-xs text-muted-foreground">
              {staleBase.latestSha.slice(0, 7)}
            </code>
          </span>
          <Button
            size="sm"
            onClick={() =>
              setBase({
                kind: "commit",
                ref: staleBase.latestSha,
                label: staleBase.branch,
              })
            }
            data-testid="update-base-to-latest"
          >
            Update base
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss banner"
            title="Dismiss"
            onClick={() => setStaleDismissedSha(staleBase.latestSha)}
            data-testid="stale-target-dismiss"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
