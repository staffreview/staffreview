import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const target = process.argv[2] ?? "current";
const outDir = "dist";

const platform = `${process.platform}-${process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch}`;
const targets: Record<string, { flag: string | null; outfile: string }> = {
  package: { flag: null, outfile: `${outDir}/staff.js` },
  current: { flag: `bun-${platform}`, outfile: `${outDir}/staff` },
  "darwin-arm64": { flag: "bun-darwin-arm64", outfile: `${outDir}/staff-darwin-arm64` },
  "darwin-x64": { flag: "bun-darwin-x64", outfile: `${outDir}/staff-darwin-x64` },
  "linux-x64": { flag: "bun-linux-x64", outfile: `${outDir}/staff-linux-x64` },
  "linux-arm64": { flag: "bun-linux-arm64", outfile: `${outDir}/staff-linux-arm64` },
};

const t = targets[target];
if (!t) {
  console.error(`unknown target: ${target}. valid: ${Object.keys(targets).join(", ")}`);
  process.exit(1);
}

if (target === "package") {
  await rm(outDir, { recursive: true, force: true });
} else {
  await rm(t.outfile, { force: true }).catch(() => {});
}

console.log(`Building ${t.outfile} for target=${t.flag ?? "bun"}…`);

const generatedAssetsPath = "src/generated/frontend-assets.ts";
const generatedAssetsPlaceholder = `export type GeneratedFrontendAsset = {
  type: string;
  body: string;
};

export const frontendHtml = "";
export const frontendAssets: Record<string, GeneratedFrontendAsset> = {};
`;

await mkdir("src/generated", { recursive: true });
let frontendOutDir: string | null = null;

function frontendAssetType(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".css":
      return "text/css;charset=utf-8";
    case ".js":
      return "text/javascript;charset=utf-8";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

async function findFrontendEntry(outDir: string, files: string[]): Promise<string | null> {
  const jsFiles = files.filter((name) => name.endsWith(".js"));
  for (const name of jsFiles) {
    const text = await readFile(join(outDir, name), "utf8");
    if (
      text.includes("document.getElementById") &&
      text.includes("#root not found") &&
      text.includes("createRoot")
    ) {
      return name;
    }
  }
  return null;
}

try {
  frontendOutDir = await mkdtemp(join(tmpdir(), "staffreview-frontend-"));
  const frontend = await Bun.build({
    entrypoints: ["src/index.html"],
    outdir: frontendOutDir,
    plugins: [tailwind],
    minify: true,
    splitting: true,
  });

  if (!frontend.success) {
    for (const log of frontend.logs) console.error(log);
    process.exit(1);
  }

  const emittedFiles = await readdir(frontendOutDir);
  let html = await readFile(join(frontendOutDir, "index.html"), "utf8").catch(() => "");
  const entryJs = await findFrontendEntry(frontendOutDir, emittedFiles);
  if (entryJs) {
    html = html.replace(
      /<script\b([^>]*\btype=["']module["'][^>]*)\bsrc=["'][^"']+\.js["']([^>]*)><\/script>/,
      `<script$1src="./${entryJs}"$2></script>`,
    );
  }

  const assets: Record<string, { type: string; body: string }> = {};
  for (const name of emittedFiles) {
    if (name.endsWith(".html")) continue;
    const body = Buffer.from(await readFile(join(frontendOutDir, name))).toString("base64");
    assets[`/${name}`] = { type: frontendAssetType(name), body };
  }

  if (!html) {
    console.error("frontend build did not produce index.html");
    process.exit(1);
  }
  if (!entryJs) {
    console.error("frontend build did not produce a recognizable app entry chunk");
    process.exit(1);
  }

  await writeFile(
    generatedAssetsPath,
    `export type GeneratedFrontendAsset = {
  type: string;
  body: string;
};

export const frontendHtml = ${JSON.stringify(html)};
export const frontendAssets: Record<string, GeneratedFrontendAsset> = ${JSON.stringify(assets)};
`,
  );

  const result = await Bun.build(
    t.flag
      ? {
          entrypoints: ["src/cli.ts"],
          compile: { target: t.flag as any, outfile: t.outfile },
          plugins: [tailwind],
          define: { "process.env.STAFF_BUILD": JSON.stringify("binary") },
          minify: true,
          // sourcemap omitted for smaller binary
        }
      : {
          entrypoints: ["src/cli.ts"],
          outdir: outDir,
          naming: { entry: "staff.js" },
          target: "bun",
          external: ["*dev-index.ts"],
          plugins: [tailwind],
          define: { "process.env.STAFF_BUILD": JSON.stringify("binary") },
          minify: true,
        },
  );

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
} finally {
  await writeFile(generatedAssetsPath, generatedAssetsPlaceholder);
  if (frontendOutDir) await rm(frontendOutDir, { recursive: true, force: true });
}

console.log(`✓ ${t.outfile}`);
