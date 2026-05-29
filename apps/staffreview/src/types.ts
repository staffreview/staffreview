export type TargetKind =
  | "working-tree"
  | "staged"
  | "branch"
  | "commit"
  | "ref";

export type DiffTarget = {
  kind: TargetKind;
  ref?: string;
  label?: string;
};

export type ResolutionStatus = "fixed" | "skipped" | "documented";

export type Resolution = {
  status: ResolutionStatus;
  body: string;
  author?: string;
  at: string;
  documentedAs?: string;
};

export type Comment = {
  id: string;
  threadId: string;
  parentId?: string;
  file?: string;
  line?: number;
  /**
   * Optional end of a multi-line selection. When set together with `line`,
   * the comment is anchored to the range `[line..endLine]` (inclusive) on
   * `side`. When omitted, the comment is single-line at `line`.
   */
  endLine?: number;
  side?: "old" | "new";
  body: string;
  author: string;
  createdAt: string;
  resolution?: Resolution;
  /**
   * Set on the root comment when a human flags the thread for
   * documentation (the "Document" button). It is NOT a resolution —
   * the thread stays open so `/staff-resolve` picks it up, writes the
   * library entry, and then resolves it as `documented`.
   */
  documentRequested?: boolean;
};

export type Diff = {
  slug: string;
  base: DiffTarget;
  head: DiffTarget;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
};

export type FileDiff = {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  oldContent: string;
  newContent: string;
  /** True when the (new, or for deletions old) entry is a symlink (git
   * mode 120000) rather than a regular file. The UI renders a compact
   * "Symlink → target" row instead of the file content. */
  isSymlink?: boolean;
  /** The path the symlink points to (current side). */
  symlinkTarget?: string;
  /** The previous target, when an existing symlink was repointed. */
  oldSymlinkTarget?: string;
};

export type GitRefInfo = {
  name: string;
  kind: "branch" | "tag" | "remote" | "commit";
  sha?: string;
  subject?: string;
};
