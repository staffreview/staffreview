import { Check, ChevronsUpDown, Minus, Monitor, Moon, Plus, Settings, Sun } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { DEFAULT_DOCS_AGENTS, MAX_DOCS_AGENTS, MIN_DOCS_AGENTS } from "../../docs-config.ts";
import { DEFAULT_LOOP_ROUNDS, MAX_LOOP_ROUNDS, MIN_LOOP_ROUNDS } from "../../loop-config.ts";
import { DEFAULT_OPEN_BROWSER } from "../../open-browser-config.ts";
import {
  DEFAULT_REVIEW_AGENTS,
  MAX_REVIEW_AGENTS,
  MIN_REVIEW_AGENTS,
} from "../../review-config.ts";
import {
  DEFAULT_DIFF_FONT_SIZE,
  DEFAULT_FILES_EXPANDED_BY_DEFAULT,
  DEFAULT_SPLIT_VIEW,
  DEFAULT_STRUCTURED_HIGHLIGHTING,
  DEFAULT_SYNTAX_THEME_DARK,
  DEFAULT_SYNTAX_THEME_LIGHT,
  DEFAULT_THEME,
} from "../default-settings.ts";
import { api, type ColorScheme, type GlobalSettings } from "../lib/api.ts";
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Switch } from "./ui/switch.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";

const MIN_DIFF_FONT_SIZE = 9;
const MAX_DIFF_FONT_SIZE = 22;
// The default set is enumerated in three places that must stay in sync when a
// persisted setting is added or its default changes:
//   1. `DEFAULT_SETTINGS` here — the full set persisted on reset.
//   2. `resetDisplaySettings` in App.tsx — the display subset applied to React
//      state on reset (so the live UI updates without a reload).
//   3. `settingsWithDefaults` in settings.ts — the server-side default subset.
// All three derive from the shared `DEFAULT_*` constants, so the *values* can't
// diverge; the hazard is forgetting to add a *new* setting to all three.
const DEFAULT_SETTINGS = {
  splitView: DEFAULT_SPLIT_VIEW,
  diffFontSize: DEFAULT_DIFF_FONT_SIZE,
  theme: DEFAULT_THEME,
  syntaxThemeLight: DEFAULT_SYNTAX_THEME_LIGHT,
  syntaxThemeDark: DEFAULT_SYNTAX_THEME_DARK,
  structuredHighlighting: DEFAULT_STRUCTURED_HIGHLIGHTING,
  filesExpandedByDefault: DEFAULT_FILES_EXPANDED_BY_DEFAULT,
  openBrowser: DEFAULT_OPEN_BROWSER,
  loopMaxRounds: DEFAULT_LOOP_ROUNDS,
  reviewAgents: DEFAULT_REVIEW_AGENTS,
  docsAgents: DEFAULT_DOCS_AGENTS,
} satisfies GlobalSettings;

const menuSectionClass = "border-t border-border/70 px-5 py-4 first:border-t-0";
const rowClass = "flex min-h-10 items-center justify-between gap-5";
const rowLabelClass = "text-sm font-medium text-muted-foreground";
const segmentedClass = "rounded-full border border-border bg-muted/40 p-0.5 shadow-inner";
const segmentItemClass = cn(
  "h-8 rounded-full border-0 px-3 text-sm font-medium text-muted-foreground shadow-none",
  "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs",
  "dark:data-[state=on]:bg-accent",
);

function MenuSection({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn(menuSectionClass, className)}>
      {label && (
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">
          {label}
        </div>
      )}
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function SettingRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className={rowClass}>
      <div className={rowLabelClass}>{label}</div>
      <div className="flex shrink-0 items-center justify-end">{children}</div>
    </div>
  );
}

function Stepper({
  decrementTestId,
  decreaseLabel,
  disabledDecrease,
  disabledIncrease,
  incrementTestId,
  increaseLabel,
  onDecrease,
  onIncrease,
  value,
}: {
  decrementTestId: string;
  decreaseLabel: string;
  disabledDecrease: boolean;
  disabledIncrease: boolean;
  incrementTestId: string;
  increaseLabel: string;
  onDecrease: () => void;
  onIncrease: () => void;
  value: ReactNode;
}) {
  return (
    <div className="inline-flex h-8 items-center overflow-hidden rounded-full border border-input bg-background shadow-xs">
      <button
        type="button"
        aria-label={decreaseLabel}
        title={decreaseLabel}
        onClick={onDecrease}
        disabled={disabledDecrease}
        data-testid={decrementTestId}
        className={cn(
          "inline-flex h-full w-8 items-center justify-center transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          "disabled:pointer-events-none disabled:opacity-40",
        )}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <div className="flex h-full min-w-18 items-center justify-center border-x border-input px-3 text-xs font-medium text-muted-foreground">
        {value}
      </div>
      <button
        type="button"
        aria-label={increaseLabel}
        title={increaseLabel}
        onClick={onIncrease}
        disabled={disabledIncrease}
        data-testid={incrementTestId}
        className={cn(
          "inline-flex h-full w-8 items-center justify-center transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          "disabled:pointer-events-none disabled:opacity-40",
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// Thin wrapper over the shadcn `Switch` primitive so the call sites keep their
// `label`/`testId` props (and the test ids the e2e specs rely on) while the
// actual switch — focus ring, keyboard handling, Radix a11y — comes from the
// canonical component rather than a hand-rolled `role="switch"` button.
function SwitchToggle({
  checked,
  label,
  onCheckedChange,
  testId,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
  testId: string;
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      data-testid={testId}
    />
  );
}

export interface SettingsMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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
  structuredHighlighting: boolean;
  onStructuredHighlightingChange: (next: boolean) => void;
  onSyntaxThemeChange: (mode: "light" | "dark", name: string) => void;
  onResetDisplaySettings: () => void;
}

export function SettingsMenu({
  open,
  onOpenChange,
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
  structuredHighlighting,
  onStructuredHighlightingChange,
  onSyntaxThemeChange,
  onResetDisplaySettings,
}: SettingsMenuProps) {
  const [syntaxPickerOpen, setSyntaxPickerOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

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
  const resetToDefaults = () => {
    onResetDisplaySettings();
    setOpenBrowserState(DEFAULT_OPEN_BROWSER);
    setLoopMaxRoundsState(DEFAULT_LOOP_ROUNDS);
    setReviewAgentsState(DEFAULT_REVIEW_AGENTS);
    setDocsAgentsState(DEFAULT_DOCS_AGENTS);
    setResetDialogOpen(false);
    onOpenChange?.(false);
    api.setSettings(DEFAULT_SETTINGS).catch(() => {});
  };

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
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
      <DropdownMenuContent
        align="end"
        className="max-h-[calc(100vh-5rem)] w-[420px] overflow-x-hidden overflow-y-auto rounded-xl p-0 shadow-xl"
      >
        <MenuSection label="Diff" className="pt-5">
          <SettingRow label="Unified layout">
            <SwitchToggle
              checked={!splitView}
              label="Unified layout"
              onCheckedChange={(checked) => onSplitViewChange(!checked)}
              testId="view-mode-unified"
            />
          </SettingRow>

          <SettingRow label="Structured highlighting">
            <SwitchToggle
              checked={structuredHighlighting}
              label="Structured highlighting"
              onCheckedChange={onStructuredHighlightingChange}
              testId="structured-highlighting-toggle"
            />
          </SettingRow>

          <SettingRow label="Collapse files">
            <SwitchToggle
              checked={!filesExpandedByDefault}
              label="Collapse files"
              onCheckedChange={(checked) => onFilesExpandedByDefaultChange(!checked)}
              testId="files-collapse-toggle"
            />
          </SettingRow>
        </MenuSection>

        <MenuSection label="Appearance">
          <SettingRow label="Font size">
            <Stepper
              decreaseLabel="Decrease diff font size"
              decrementTestId="diff-font-decrease"
              disabledDecrease={diffFontSize <= MIN_DIFF_FONT_SIZE}
              disabledIncrease={diffFontSize >= MAX_DIFF_FONT_SIZE}
              increaseLabel="Increase diff font size"
              incrementTestId="diff-font-increase"
              onDecrease={() => onDiffFontSizeChange(diffFontSize - 1)}
              onIncrease={() => onDiffFontSizeChange(diffFontSize + 1)}
              value={
                <span className="font-mono" data-testid="diff-font-size">
                  {diffFontSize}px
                </span>
              }
            />
          </SettingRow>

          <SettingRow label="Color mode">
            <ToggleGroup
              type="single"
              size="sm"
              value={theme}
              onValueChange={(v) => {
                if (v === "system" || v === "light" || v === "dark") onThemeChange(v);
              }}
              aria-label="Color scheme"
              className={segmentedClass}
            >
              <ToggleGroupItem
                value="system"
                className={segmentItemClass}
                data-testid="theme-system"
                title="System"
              >
                <Monitor className="h-3.5 w-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="light"
                className={segmentItemClass}
                data-testid="theme-light"
                title="Light"
              >
                <Sun className="h-3.5 w-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="dark"
                className={segmentItemClass}
                data-testid="theme-dark"
                title="Dark"
              >
                <Moon className="h-3.5 w-3.5" />
              </ToggleGroupItem>
            </ToggleGroup>
          </SettingRow>

          <SettingRow label="Syntax theme">
            {(() => {
              const list = effectiveTheme === "dark" ? DARK_SYNTAX_THEMES : LIGHT_SYNTAX_THEMES;
              const current = effectiveTheme === "dark" ? syntaxThemeDark : syntaxThemeLight;
              return (
                <Popover open={syntaxPickerOpen} onOpenChange={setSyntaxPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      role="combobox"
                      aria-expanded={syntaxPickerOpen}
                      className="h-8 max-w-44 justify-between rounded-full px-3 font-mono text-xs"
                      data-testid="syntax-theme-button"
                    >
                      <span className="truncate">{current}</span>
                      <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[260px] p-0"
                    align="end"
                    // The picker lives inside a DropdownMenu — stop key events
                    // from bubbling up to its built-in first-letter typeahead.
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
              );
            })()}
          </SettingRow>
        </MenuSection>

        <MenuSection label="Behavior">
          <SettingRow label="Auto launch browser">
            <SwitchToggle
              checked={openBrowser}
              label="Auto launch browser"
              onCheckedChange={setOpenBrowser}
              testId="open-browser-auto"
            />
          </SettingRow>
        </MenuSection>

        <MenuSection label="Agents">
          <SettingRow label="Loop">
            <Stepper
              decreaseLabel="Fewer /staff-loop rounds"
              decrementTestId="loop-rounds-decrease"
              disabledDecrease={loopMaxRounds <= MIN_LOOP_ROUNDS}
              disabledIncrease={loopMaxRounds >= MAX_LOOP_ROUNDS}
              increaseLabel="More /staff-loop rounds"
              incrementTestId="loop-rounds-increase"
              onDecrease={() => setLoopMaxRounds(loopMaxRounds - 1)}
              onIncrease={() => setLoopMaxRounds(loopMaxRounds + 1)}
              value={
                <span data-testid="loop-rounds-value">
                  {loopMaxRounds} {loopMaxRounds === 1 ? "round" : "rounds"} max
                </span>
              }
            />
          </SettingRow>

          <SettingRow label="Review">
            <Stepper
              decreaseLabel="Fewer /staff-review agents"
              decrementTestId="review-agents-decrease"
              disabledDecrease={reviewAgents <= MIN_REVIEW_AGENTS}
              disabledIncrease={reviewAgents >= MAX_REVIEW_AGENTS}
              increaseLabel="More /staff-review agents"
              incrementTestId="review-agents-increase"
              onDecrease={() => setReviewAgents(reviewAgents - 1)}
              onIncrease={() => setReviewAgents(reviewAgents + 1)}
              value={
                <span data-testid="review-agents-value">
                  {reviewAgents} {reviewAgents === 1 ? "agent" : "agents"}
                </span>
              }
            />
          </SettingRow>

          <SettingRow label="Docs">
            <Stepper
              decreaseLabel="Fewer /staff-docs agents"
              decrementTestId="docs-agents-decrease"
              disabledDecrease={docsAgents <= MIN_DOCS_AGENTS}
              disabledIncrease={docsAgents >= MAX_DOCS_AGENTS}
              increaseLabel="More /staff-docs agents"
              incrementTestId="docs-agents-increase"
              onDecrease={() => setDocsAgents(docsAgents - 1)}
              onIncrease={() => setDocsAgents(docsAgents + 1)}
              value={
                <span data-testid="docs-agents-value">
                  {docsAgents} {docsAgents === 1 ? "agent" : "agents"}
                </span>
              }
            />
          </SettingRow>
        </MenuSection>

        <MenuSection className="pb-5">
          <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-center rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/20"
                data-testid="settings-reset-button"
              >
                Reset to defaults
              </Button>
            </DialogTrigger>
            <DialogContent showCloseButton={false} className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Reset settings?</DialogTitle>
                <DialogDescription>
                  This will restore the review UI, appearance, launch, and agent settings to their
                  defaults.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline" data-testid="settings-reset-cancel">
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={resetToDefaults}
                  data-testid="settings-reset-confirm"
                >
                  Reset
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </MenuSection>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
