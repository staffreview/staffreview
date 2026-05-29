import { useMemo, useState } from "react";
import { ChevronsUpDown, GitBranch, GitCommit, GitMerge, Tag } from "lucide-react";
import type { DiffTarget, GitRefInfo } from "../../types.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command.tsx";
import { Badge } from "./ui/badge.tsx";
import { cn } from "../lib/utils.ts";

type Special = { id: string; label: string; target: DiffTarget };

const SPECIALS: Special[] = [
  { id: "working-tree", label: "Working tree", target: { kind: "working-tree" } },
  { id: "staged", label: "Staged changes", target: { kind: "staged" } },
];

function targetLabel(t: DiffTarget) {
  if (t.kind === "working-tree") return "Working tree";
  if (t.kind === "staged") return "Staged";
  return t.ref ?? "(none)";
}

function iconForKind(kind: GitRefInfo["kind"]) {
  if (kind === "branch") return <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />;
  if (kind === "remote") return <GitMerge className="h-3.5 w-3.5 text-muted-foreground" />;
  if (kind === "tag") return <Tag className="h-3.5 w-3.5 text-muted-foreground" />;
  return <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />;
}

export function TargetPicker({
  label,
  value,
  refs,
  onChange,
  includeWorkingState = true,
}: {
  label: string;
  value: DiffTarget;
  refs: GitRefInfo[];
  onChange: (t: DiffTarget) => void;
  includeWorkingState?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Idle (no-query) visible counts per list; "View more" grows them by 10.
  const INITIAL = 5;
  const STEP = 10;
  const [branchLimit, setBranchLimit] = useState(INITIAL);
  const [commitLimit, setCommitLimit] = useState(INITIAL);

  const groups = useMemo(() => {
    const branches = refs.filter((r) => r.kind === "branch");
    const remotes = refs.filter((r) => r.kind === "remote");
    const tags = refs.filter((r) => r.kind === "tag");
    // Hide commits that are already represented by a branch/tag/remote
    // tip — picking the named entry is the better choice (it follows the
    // branch and powers the stale-base banner).
    const namedShas = new Set(
      refs
        .filter(
          (r) => (r.kind === "branch" || r.kind === "remote" || r.kind === "tag") && r.sha,
        )
        .map((r) => r.sha as string),
    );
    const commits = refs.filter((r) => r.kind === "commit" && !namedShas.has(r.sha ?? ""));
    return { branches, remotes, tags, commits };
  }, [refs]);

  // When idle (no query) the lists are capped so the picker stays scannable
  // — "View more" reveals the next batch. Typing a query shows everything so
  // all branches/commits stay searchable (no cap). Branches are ordered
  // most-recent-first (git --sort=-committerdate); the branch cap always
  // pins `main`/`master` if present, even when it's not recent.
  const searching = search.trim().length > 0;
  const branchesShown = useMemo(() => {
    if (searching) return groups.branches;
    const top = groups.branches.slice(0, branchLimit);
    const main = groups.branches.find((b) => b.name === "main" || b.name === "master");
    if (main && !top.includes(main)) top.push(main);
    return top;
  }, [searching, groups.branches, branchLimit]);
  const commitsShown = searching ? groups.commits : groups.commits.slice(0, commitLimit);
  const branchesHidden = groups.branches.length - branchesShown.length;
  const commitsHidden = groups.commits.length - commitsShown.length;

  return (
    <div className="flex items-center gap-2" data-testid={`target-picker-${label}`}>
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground w-9">{label}</span>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            // Reset so the cap (and search) applies fresh next open.
            setSearch("");
            setBranchLimit(INITIAL);
            setCommitLimit(INITIAL);
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="min-w-[220px] justify-between font-mono text-xs" data-testid={`target-picker-${label}-button`} aria-label={`${label} target`}>
            <span className="flex items-center gap-2 truncate">
              {value.kind === "working-tree" || value.kind === "staged" ? (
                <Badge variant="outline" className="font-sans">{targetLabel(value)}</Badge>
              ) : (
                <>
                  <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="truncate">{targetLabel(value)}</span>
                </>
              )}
            </span>
            <ChevronsUpDown className="ml-2 h-3.5 w-3.5 opacity-50 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[360px] p-0">
          <Command>
            <CommandInput
              placeholder="Search refs…"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>No matches.</CommandEmpty>
              {includeWorkingState && (
                <CommandGroup heading="Working state">
                  {SPECIALS.map((s) => (
                    <CommandItem
                      key={s.id}
                      value={s.id}
                      keywords={[s.label]}
                      onSelect={() => {
                        onChange(s.target);
                        setOpen(false);
                      }}
                      className={cn(value.kind === s.target.kind && "bg-accent")}
                    >
                      <Badge variant="outline">{s.label}</Badge>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {branchesShown.length > 0 && (
                <CommandGroup heading="Branches">
                  {branchesShown.map((r) => (
                    <NamedRefItem
                      key={`b:${r.name}`}
                      ref={r}
                      prefix="b"
                      selected={value.ref === r.sha}
                      onPick={onChange}
                      close={() => setOpen(false)}
                    />
                  ))}
                  {branchesHidden > 0 && (
                    <ViewMore
                      testid="view-more-branches"
                      hidden={branchesHidden}
                      step={STEP}
                      onClick={() => setBranchLimit((n) => n + STEP)}
                    />
                  )}
                </CommandGroup>
              )}
              {groups.remotes.length > 0 && (
                <CommandGroup heading="Remote branches">
                  {groups.remotes.map((r) => (
                    <NamedRefItem
                      key={`r:${r.name}`}
                      ref={r}
                      prefix="r"
                      selected={value.ref === r.sha}
                      onPick={onChange}
                      close={() => setOpen(false)}
                    />
                  ))}
                </CommandGroup>
              )}
              {groups.tags.length > 0 && (
                <CommandGroup heading="Tags">
                  {groups.tags.map((r) => (
                    <NamedRefItem
                      key={`t:${r.name}`}
                      ref={r}
                      prefix="t"
                      selected={value.ref === r.sha}
                      onPick={onChange}
                      close={() => setOpen(false)}
                    />
                  ))}
                </CommandGroup>
              )}
              {commitsShown.length > 0 && (
                <CommandGroup heading="Recent commits">
                  {commitsShown.map((r) => {
                    // If this commit is the current HEAD of a branch/tag/
                    // remote, prefer that name as the label so the staleness
                    // banner has something to compare against.
                    const headOf = refs.find(
                      (x) =>
                        (x.kind === "branch" || x.kind === "remote" || x.kind === "tag") &&
                        x.sha === r.sha,
                    );
                    return (
                      <CommandItem
                        key={`c:${r.sha}`}
                        value={`${r.name} c`}
                        keywords={[r.sha ?? "", r.subject ?? ""].filter(Boolean)}
                        onSelect={() => {
                          onChange({
                            kind: "commit",
                            ref: r.sha,
                            label: headOf?.name ?? `${r.name} ${r.subject ?? ""}`.trim(),
                          });
                          setOpen(false);
                        }}
                      >
                        {iconForKind(r.kind)}
                        <span className="font-mono text-xs">{r.name}</span>
                        <span className="text-xs text-muted-foreground truncate">{r.subject}</span>
                        {headOf && (
                          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                            {headOf.name}
                          </span>
                        )}
                      </CommandItem>
                    );
                  })}
                  {commitsHidden > 0 && (
                    <ViewMore
                      testid="view-more-commits"
                      hidden={commitsHidden}
                      step={STEP}
                      onClick={() => setCommitLimit((n) => n + STEP)}
                    />
                  )}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * A non-item "View more" row that reveals the next batch of a capped
 * list. It's a plain button (not a CommandItem) so cmdk's keyboard
 * navigation and search filtering skip it; `onMouseDown` preventDefault
 * keeps focus in the search input.
 */
function ViewMore({
  testid,
  hidden,
  step,
  onClick,
}: {
  testid: string;
  hidden: number;
  step: number;
  onClick: () => void;
}) {
  const n = Math.min(step, hidden);
  return (
    <button
      type="button"
      data-testid={testid}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex w-full items-center justify-center rounded-sm px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
    >
      View {n} more
    </button>
  );
}

/**
 * Render a branch/tag/remote entry with the same layout as the "Recent
 * commits" rows: name on the left, commit subject in the middle, short
 * SHA on the right.
 */
function NamedRefItem({
  ref: r,
  prefix,
  selected,
  onPick,
  close,
}: {
  ref: GitRefInfo;
  prefix: "b" | "r" | "t";
  selected: boolean;
  onPick: (t: DiffTarget) => void;
  close: () => void;
}) {
  return (
    <CommandItem
      // The searchable value is just the ref name so an exact query like
      // "main" scores 1.0 and ranks first. The SHA and commit subject are
      // still matchable via `keywords`, but don't pollute the name score.
      // The `prefix` keeps values unique across groups (branch/remote/tag
      // can share a name).
      value={`${r.name} ${prefix}`}
      keywords={[r.sha ?? "", r.subject ?? ""].filter(Boolean)}
      onSelect={() => {
        onPick({ kind: "commit", ref: r.sha ?? r.name, label: r.name });
        close();
      }}
      className={cn(selected && "bg-accent")}
    >
      {iconForKind(r.kind)}
      <span className="font-mono text-xs">{r.name}</span>
      {r.subject && (
        <span className="text-xs text-muted-foreground truncate">{r.subject}</span>
      )}
      {r.sha && (
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {r.sha.slice(0, 7)}
        </span>
      )}
    </CommandItem>
  );
}
