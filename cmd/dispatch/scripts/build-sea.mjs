// Build a Node Single Executable Application binary for `dispatch`.
//
// Steps mirror https://nodejs.org/api/single-executable-applications.html:
//   1. Generate the SEA blob from sea-config.json.
//   2. Copy the current node binary to dist/dispatch.
//   3. Inject the blob with `postject`.
//
// `postject` is invoked via npx so we don't carry it as a hard dep — it's only
// needed on the host that produces the binary, not on every dev's machine.

import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const BLOB = join(DIST, "dispatch.sea.blob");
const OUT = join(DIST, "dispatch");

mkdirSync(DIST, { recursive: true });

console.error("[sea] generating blob");
execFileSync(process.execPath, ["--experimental-sea-config", join(ROOT, "sea-config.json")], {
  cwd: ROOT,
  stdio: "inherit",
});

console.error(`[sea] copying ${process.execPath} -> ${OUT}`);
copyFileSync(process.execPath, OUT);
chmodSync(OUT, 0o755);

console.error("[sea] injecting blob via postject");
execFileSync(
  "npx",
  [
    "--yes",
    "postject",
    OUT,
    "NODE_SEA_BLOB",
    BLOB,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ],
  { stdio: "inherit" },
);

console.error(`[sea] built ${OUT}`);
