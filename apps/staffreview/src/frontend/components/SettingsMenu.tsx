import {
  ChevronsUpDown,
  Check,
  Columns2,
  ExternalLink,
  FoldVertical,
  Loader2,
  Minus,
  Monitor,
  Moon,
  MousePointer2,
  Plus,
  RefreshCw,
  Rows2,
  Settings,
  Sun,
  UnfoldVertical,
} from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_LOOP_ROUNDS, MIN_LOOP_ROUNDS, MAX_LOOP_ROUNDS } from "../../loop-config.ts";
import { DEFAULT_OPEN_BROWSER } from "../../open-browser-config.ts";
import {
  DEFAULT_DOCS_AGENTS,
  MIN_DOCS_AGENTS,
  MAX_DOCS_AGENTS,
} from "../../docs-config.ts";
import {
  DEFAULT_REVIEW_AGENTS,
  MIN_REVIEW_AGENTS,
  MAX_REVIEW_AGENTS,
} from "../../review-config.ts";
import { api, type ColorScheme } from "../lib/api.ts";
import { DARK_SYNTAX_THEMES, LIGHT_SYNTAX_THEMES } from "../lib/highlight.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";

const MIN_DIFF_FONT_SIZE = 9;
const MAX_DIFF_FONT_SIZE = 22;

export interface SettingsMenuProps {
  loadingDiff: boolean;
  onRefresh: () => void;
  splitView: boolean;
  onSplitViewChange: (next: boolean) => void;
  filesExpandedByDefault: boolean;
  onFilesExpandedByDefaultChange: (next: boolean) => void;
  diffFontSize: number;
  onDiffFontSizeChange: (next: number) => void;
  theme: ColorScheme;
  onThemeChange: (next: ColorScheme) => void;
  effectiveTheme: "light" | "dark";
  syntaxThemeLight: string;
  syntaxThemeDark: string;
  onSyntaxThemeChange: (mode: "light" | "dark", name: string) => void;
}

export function SettingsMenu({
  loadingDiff,
  onRefresh,
  splitView,
  onSplitViewChange,
  filesExpandedByDefault,
  onFilesExpandedByDefaultChange,
  diffFontSize,
  onDiffFontSizeChange,
  theme,
  onThemeChange,
  effectiveTheme,
  syntaxThemeLight,
  syntaxThemeDark,
  onSyntaxThemeChange,
}: SettingsMenuProps) {
  const [syntaxPickerOpen, setSyntaxPickerOpen] = useState(false);

  // Hard cap on review→resolve rounds for the /staff-loop skill. Default and
  // bounds come from loop-config.ts, shared with the server (settings.ts).
  const [loopMaxRounds, setLoopMaxRoundsState] = useState<number>(DEFAULT_LOOP_ROUNDS);
  // How many sub-agents /staff-review fans out per phase. Default + bounds from
  // review-config.ts, shared with the server (settings.ts).
  const [reviewAgents, setReviewAgentsState] = useState<number>(DEFAULT_REVIEW_AGENTS);
  // How many scout sub-agents /staff-docs fans out. Default + bounds from
  // docs-config.ts, shared with the server (settings.ts).
  const [docsAgents, setDocsAgentsState] = useState<number>(DEFAULT_DOCS_AGENTS);
  const [openBrowser, setOpenBrowserState] = useState<boolean>(DEFAULT_OPEN_BROWSER);

  // These controls are write-only (nothing in the app renders from them),
  // so SettingsMenu owns their load + persist directly. Values App renders with
  // come down as props.
  useEffect(() => {
    (async () => {
      try {
        const { settings } = await api.settings();
        if (typeof settings.loopMaxRounds === "number") {
          setLoopMaxRoundsState(
            Math.min(MAX_LOOP_ROUNDS, Math.max(MIN_LOOP_ROUNDS, settings.loopMaxRounds)),
          );
        }
        if (typeof settings.reviewAgents === "number") {
          setReviewAgentsState(
            Math.min(MAX_REVIEW_AGENTS, Math.max(MIN_REVIEW_AGENTS, settings.reviewAgents)),
          );
        }
        if (typeof settings.docsAgents === "number") {
          setDocsAgentsState(
            Math.min(MAX_DOCS_AGENTS, Math.max(MIN_DOCS_AGENTS, settings.docsAgents)),
          );
        }
        if (typeof settings.openBrowser === "boolean") {
          setOpenBrowserState(settings.openBrowser);
        }
      } catch {}
    })();
  }, []);

  const setLoopMaxRounds = (next: number) => {
    const clamped = Math.min(MAX_LOOP_ROUNDS, Math.max(MIN_LOOP_ROUNDS, next));
    setLoopMaxRoundsState(clamped);
    api.setSettings({ loopMaxRounds: clamped }).catch(() => {});
  };
  const setReviewAgents = (next: number) => {
    const clamped = Math.min(MAX_REVIEW_AGENTS, Math.max(MIN_REVIEW_AGENTS, next));
    setReviewAgentsState(clamped);
    api.setSettings({ reviewAgents: clamped }).catch(() => {});
  };
  const setDocsAgents = (next: number) => {
    const clamped = Math.min(MAX_DOCS_AGENTS, Math.max(MIN_DOCS_AGENTS, next));
    setDocsAgentsState(clamped);
    api.setSettings({ docsAgents: clamped }).catch(() => {});
  };
  const setOpenBrowser = (next: boolean) => {
    setOpenBrowserState(next);
    api.setSettings({ openBrowser: next }).catch(() => {});
  };

  return (
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
          onSelect={() => onRefresh()}
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
        <DropdownMenuLabel>Open web UI in browser</DropdownMenuLabel>
        <div className="px-2 py-1">
          <p className="mb-1.5 text-xs text-muted-foreground">
            When you run <span className="font-mono">staff serve</span>, open this
            web UI in your browser automatically.
          </p>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={openBrowser ? "open" : "manual"}
            onValueChange={(v) => {
              if (v) setOpenBrowser(v === "open");
            }}
            aria-label="Open web UI in browser on launch"
            className="w-full"
          >
            <ToggleGroupItem
              value="open"
              className="flex-1"
              data-testid="open-browser-auto"
              title="Open the web UI in your browser automatically when the server starts"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open automatically
            </ToggleGroupItem>
            <ToggleGroupItem
              value="manual"
              className="flex-1"
              data-testid="open-browser-manual"
              title="Don't open a browser; print the URL and let me open it myself"
            >
              <MousePointer2 className="h-3.5 w-3.5" />
              I'll open it
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <DropdownMenuLabel>View mode</DropdownMenuLabel>
        <div className="px-2 py-1">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={splitView ? "split" : "unified"}
            onValueChange={(v) => {
              if (v) onSplitViewChange(v === "split");
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
              if (v) onFilesExpandedByDefaultChange(v === "expanded");
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
              onClick={() => onDiffFontSizeChange(diffFontSize - 1)}
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
              onClick={() => onDiffFontSizeChange(diffFontSize + 1)}
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
              if (v === "system" || v === "light" || v === "dark") onThemeChange(v);
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
                              onSyntaxThemeChange(effectiveTheme, t);
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
        <DropdownMenuLabel>Review agents</DropdownMenuLabel>
        <div className="px-2 py-1 flex items-center gap-2">
          <div className="inline-flex h-8 items-center rounded-md border border-input bg-background shadow-xs">
            <button
              type="button"
              aria-label="Fewer /staff-review agents"
              title="Fewer agents"
              onClick={() => setReviewAgents(reviewAgents - 1)}
              disabled={reviewAgents <= MIN_REVIEW_AGENTS}
              data-testid="review-agents-decrease"
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
              aria-label="More /staff-review agents"
              title="More agents"
              onClick={() => setReviewAgents(reviewAgents + 1)}
              disabled={reviewAgents >= MAX_REVIEW_AGENTS}
              data-testid="review-agents-increase"
              className={cn(
                "inline-flex h-full w-8 items-center justify-center rounded-r-md",
                "transition-colors hover:bg-accent hover:text-accent-foreground",
                "disabled:pointer-events-none disabled:opacity-40",
              )}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <span className="text-xs text-muted-foreground" data-testid="review-agents-value">
            {reviewAgents} {reviewAgents === 1 ? "agent" : "agents"}
          </span>
        </div>
        <DropdownMenuLabel>Docs agents</DropdownMenuLabel>
        <div className="px-2 py-1 flex items-center gap-2">
          <div className="inline-flex h-8 items-center rounded-md border border-input bg-background shadow-xs">
            <button
              type="button"
              aria-label="Fewer /staff-docs agents"
              title="Fewer agents"
              onClick={() => setDocsAgents(docsAgents - 1)}
              disabled={docsAgents <= MIN_DOCS_AGENTS}
              data-testid="docs-agents-decrease"
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
              aria-label="More /staff-docs agents"
              title="More agents"
              onClick={() => setDocsAgents(docsAgents + 1)}
              disabled={docsAgents >= MAX_DOCS_AGENTS}
              data-testid="docs-agents-increase"
              className={cn(
                "inline-flex h-full w-8 items-center justify-center rounded-r-md",
                "transition-colors hover:bg-accent hover:text-accent-foreground",
                "disabled:pointer-events-none disabled:opacity-40",
              )}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <span className="text-xs text-muted-foreground" data-testid="docs-agents-value">
            {docsAgents} {docsAgents === 1 ? "agent" : "agents"}
          </span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
