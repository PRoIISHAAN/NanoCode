// Bundles the `nanocode` binary into one self-contained JS file, for install.sh's global install
// (and anyone else who wants a fast-starting binary instead of running from source via `tsx`).
//
// Only `@nanocode/*` workspace packages are inlined -- real npm dependencies (react, ink, pi-ai,
// ...) stay external `import`s, resolved normally from node_modules at runtime, the same way any
// other Node program's dependencies are. This isn't esbuild's default behavior for a monorepo: its
// own module resolution would treat every `@nanocode/*` import the SAME way it treats a real
// node_modules package (since npm workspaces link them there too) and leave them external as well
// -- entirely defeating the point of bundling, since the whole reason to bundle at all is to fold
// nanocode's OWN multi-package source into one file so a global install doesn't need `tsx`
// transpiling six packages' worth of TypeScript on every launch. The `alias` map below overrides
// that: it points each `@nanocode/*` specifier straight at its package's real `src/index.ts`,
// which IS eligible for bundling (it's source esbuild can read and inline, not a prebuilt
// node_modules artifact), while `packages: "external"` leaves every other node_modules resolution
// alone.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, "..");
const repoRoot = resolve(cliRoot, "../..");

function workspaceSrc(name) {
  const path = resolve(repoRoot, "packages", name, "src/index.ts");
  if (!existsSync(path)) {
    throw new Error(`Expected a workspace entry file at ${path} -- did packages/${name} move?`);
  }
  return path;
}

await build({
  entryPoints: [resolve(cliRoot, "src/index.ts")],
  outfile: resolve(cliRoot, "dist/cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  alias: {
    "@nanocode/agent": workspaceSrc("agent"),
    "@nanocode/ai": workspaceSrc("ai"),
    "@nanocode/kernel": workspaceSrc("kernel"),
    "@nanocode/tui": workspaceSrc("tui"),
  },
  // No explicit `banner` for the shebang -- esbuild already hoists the entry file's OWN
  // `#!/usr/bin/env node` (index.ts's first line) to the top of the bundle automatically. Adding
  // one here too produced a real, caught-live bug: TWO shebang lines, and Node's ESM loader only
  // tolerates one as the literal first line of the file -- a second `#!` a line down is invalid JS
  // syntax, so the bundle failed to even parse.
  sourcemap: true,
  logLevel: "info",
});
