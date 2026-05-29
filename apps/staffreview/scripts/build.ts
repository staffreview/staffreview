import { rm } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";

const target = process.argv[2] ?? "current";
const outDir = "dist";

const platform = `${process.platform}-${process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch}`;
const targets: Record<string, { flag: string; outfile: string }> = {
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

await rm(t.outfile, { force: true }).catch(() => {});

console.log(`Building ${t.outfile} for target=${t.flag}…`);

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  compile: { target: t.flag as any, outfile: t.outfile },
  plugins: [tailwind],
  define: { "process.env.STAFF_BUILD": JSON.stringify("binary") },
  minify: true,
  // sourcemap omitted for smaller binary
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`✓ ${t.outfile}`);
