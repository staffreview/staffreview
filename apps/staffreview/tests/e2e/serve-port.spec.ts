import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { staff } from "./helpers.ts";
import { SCRATCH_DIR, STAFF_CONFIG_DIR, TEST_PORT } from "./setup.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.ts");

function waitForServeUrl(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timed out waiting for staff serve URL. stderr: ${stderr}`));
    }, 10_000);
    child.stdout.on("data", (b) => {
      stdout += b.toString();
      const match = stdout.match(/https?:\/\/[^\s]+/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(match[0]);
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`staff serve exited before printing URL (code ${code}). stderr: ${stderr}`));
    });
  });
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function requestWithHost(
  url: URL,
  host: string,
  path = "/api/settings",
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: url.port,
        path,
        headers: { Host: host },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.setTimeout(5_000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function frontendAssetPaths(html: string): string[] {
  return [...html.matchAll(/(?:href|src)=["']([^"']+\.(?:css|js))["']/g)].map(
    (match) => new URL(match[1], "http://staff.local/").pathname,
  );
}

// The `staff()` helper rejects (throws) when the CLI exits non-zero, embedding
// stderr in the error message — so these assert the clean failure paths of
// `staff serve` without needing to keep a server running.

test("serve rejects an invalid --port with a clear error", async () => {
  await expect(staff(["serve", "--port", "abc", "--no-open"])).rejects.toThrow(/invalid port/i);
  await expect(staff(["serve", "--port", "99999", "--no-open"])).rejects.toThrow(/invalid port/i);
});

test("serve fails cleanly when the requested port is already bound", async () => {
  // The Playwright web server is already listening on TEST_PORT, so binding it
  // again must fail with the friendly message rather than an uncaught stack.
  await expect(
    staff(["serve", "--port", String(TEST_PORT), "--no-open"]),
  ).rejects.toThrow(new RegExp(`could not bind port ${TEST_PORT}`, "i"));
});

test("serve accepts proxy hostnames over IPv4 loopback", async () => {
  const child = spawn("bun", [CLI, "--repo", SCRATCH_DIR, "serve", "--port", "0", "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, STAFF_CONFIG_DIR },
  });
  try {
    const url = new URL(await waitForServeUrl(child));
    const host = `staff-proxy.test:${url.port}`;
    await expect(requestWithHost(url, host)).resolves.toMatchObject({ status: 200 });

    const html = await requestWithHost(url, host, "/");
    expect(html.status).toBe(200);
    const assets = frontendAssetPaths(html.body);
    expect(assets.some((path) => path.endsWith(".css"))).toBe(true);
    expect(assets.some((path) => path.endsWith(".js"))).toBe(true);
    for (const asset of assets) {
      await expect(requestWithHost(url, host, asset)).resolves.toMatchObject({ status: 200 });
    }

    const staleCss = await requestWithHost(url, host, "/chunk-stale.css");
    expect(staleCss.status).toBe(302);
    expect(staleCss.headers.location).toContain(".css");
    expect(staleCss.headers.location).toMatch(/^\//);
    const staleJs = await requestWithHost(url, host, "/chunk-stale.js");
    expect(staleJs.status).toBe(302);
    expect(staleJs.headers.location).toContain(".js");
    expect(staleJs.headers.location).toMatch(/^\//);
  } finally {
    await stopChild(child);
  }
});
