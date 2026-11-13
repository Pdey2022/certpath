import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(directory, "../../dist/lambda-scrypt-benchmark");

await mkdir(outputDirectory, { recursive: true });
await build({
  bundle: true,
  entryPoints: [
    { in: resolve(directory, "handler.ts"), out: "handler" },
    { in: resolve(directory, "runner.ts"), out: "runner" },
    { in: resolve(directory, "cleanup.ts"), out: "cleanup" },
  ],
  format: "esm",
  outdir: outputDirectory,
  outExtension: { ".js": ".mjs" },
  platform: "node",
  target: "node22",
});

console.log(`Created benchmark bundles in ${outputDirectory}`);
