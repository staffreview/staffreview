import { spawn } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRATCH_DIR, STAFF_CONFIG_DIR } from "./setup.ts";

/**
 * The slice of a Playwright Locator we use to type into the editor. We
 * type it structurally rather than importing `@playwright/test` here:
 * importing it into a non-spec module registers a second test instance
 * and breaks `test.beforeEach` collection.
 */
type EditorLocator = {
  click(): Promise<void>;
  press(key: string): Promise<void>;
  pressSequentially(text: string): Promise<void>;
};

/**
 * Type plain text into a TipTap WYSIWYG comment editor (a contenteditable
 * `role=textbox`, so `.fill()` from the textarea days doesn't apply).
 * Clears any existing content first, then types so ProseMirror stays in
 * sync. Use only with plain text that won't trigger markdown input rules.
 */
export async function fillEditor(editor: EditorLocator, text: string): Promise<void> {
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.press("Delete");
  await editor.pressSequentially(text);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.ts");

/** Run the staff CLI in dev mode against the scratch repo. Returns stdout. */
export async function staff(args: string[], opts: { stdin?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [CLI, "--repo", SCRATCH_DIR, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      // Point the CLI at the same isolated global-settings dir the test server
      // uses (STAFF_CONFIG_DIR from setup.ts), so `staff settings …` reads/writes
      // the same file as the UI, not the developer's real ~/.config/staffreview.
      env: { ...process.env, STAFF_CONFIG_DIR },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    if (opts.stdin) child.stdin.end(opts.stdin);
    else child.stdin.end();
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`staff ${args.join(" ")} (exit ${code}): ${stderr}`));
    });
  });
}

export async function resetDiffsJson(): Promise<void> {
  // Clear the contents but keep the directories themselves so the server's
  // fs.watch handles remain valid across tests.
  const staffDir = join(SCRATCH_DIR, ".staffreview");
  try {
    await stat(staffDir);
  } catch {
    return;
  }
  await rm(join(staffDir, "active.json"), { force: true });
  for (const sub of ["diffs", "library", "attachments"]) {
    const dir = join(staffDir, sub);
    try {
      for (const name of await readdir(dir)) {
        await rm(join(dir, name), { recursive: true, force: true });
      }
    } catch {}
  }
}

export async function readActiveDiff(): Promise<any> {
  const text = await staff(["active", "--json"]);
  return JSON.parse(text);
}
