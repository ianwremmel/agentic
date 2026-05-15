// Node SEA build pipeline for the dispatch CLI.
//
// Produces four standalone executables from dist/dispatch.cjs (built by
// scripts/bundle.mjs):
//
//   dist/dispatch-darwin-arm64
//   dist/dispatch-darwin-x64
//   dist/dispatch-linux-x64
//   dist/dispatch-linux-arm64
//
// Pipeline per target:
//   1. Download the pinned node binary tarball from nodejs.org.
//   2. Cache under dist/.node/<version>/<platform>-<arch>/node.
//   3. Generate the SEA blob with `node --experimental-sea-config`.
//   4. Copy the cached node binary to dist/dispatch-<platform>-<arch>.
//   5. Inject the blob with postject using the documented fuse sentinel.
//   6. On macOS targets: remove the existing ad-hoc signature before
//      injection and re-sign with `codesign --sign -` after (best effort,
//      skipped if codesign is unavailable on the build host).
//   7. Strip the binary where a compatible `strip` is available.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distDir = resolve(root, "dist");
const nodeCacheDir = resolve(distDir, ".node");
const bundlePath = resolve(distDir, "dispatch.cjs");

// Pinned Node major.minor.patch. Keep in lockstep with package.json#engines.
// Bumping this changes the per-target binary footprint.
const NODE_VERSION = "22.13.0";

// SEA fuse sentinel published by Node — see the single-executable-applications
// docs. Postject uses this to mark where the blob is injected.
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** @typedef {{ platform: "darwin" | "linux", arch: "arm64" | "x64" }} Target */
/** @type {Target[]} */
const TARGETS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
];

function ensureBundle() {
  if (!existsSync(bundlePath)) {
    throw new Error(
      `Missing ${bundlePath}. Run \`npm run bundle\` first (or use \`npm run build\`).`,
    );
  }
}

function targetTarball(/** @type {Target} */ t) {
  // nodejs.org publishes <prefix>-<platform>-<arch>.tar.xz; macOS uses
  // "darwin" and linux uses "linux", matching our Target shape directly.
  return `node-v${NODE_VERSION}-${t.platform}-${t.arch}.tar.xz`;
}

function tarballUrl(/** @type {Target} */ t) {
  return `https://nodejs.org/dist/v${NODE_VERSION}/${targetTarball(t)}`;
}

async function downloadFile(
  /** @type {string} */ url,
  /** @type {string} */ dest,
) {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${url} (${res.status})`);
  }
  const ws = createWriteStream(dest);
  // Stream the body to disk. Avoids buffering ~30 MB tarballs in memory.
  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) ws.write(value);
  }
  await new Promise((res2, rej) => {
    ws.end((err) => (err ? rej(err) : res2(undefined)));
  });
}

function extractNodeBinary(
  /** @type {string} */ tarballPath,
  /** @type {Target} */ t,
  /** @type {string} */ destBinary,
) {
  // The tarball layout is:
  //   node-vX.Y.Z-<platform>-<arch>/bin/node
  // Extract just the binary into the cache. tar is universally available on
  // macOS and Linux dev hosts plus GitHub Actions runners.
  const member = `node-v${NODE_VERSION}-${t.platform}-${t.arch}/bin/node`;
  mkdirSync(dirname(destBinary), { recursive: true });
  const tmpRoot = resolve(nodeCacheDir, `.extract-${t.platform}-${t.arch}`);
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });
  execFileSync("tar", ["-xJf", tarballPath, "-C", tmpRoot, member], {
    stdio: "inherit",
  });
  copyFileSync(resolve(tmpRoot, member), destBinary);
  chmodSync(destBinary, 0o755);
  rmSync(tmpRoot, { recursive: true, force: true });
}

async function ensureNodeBinary(/** @type {Target} */ t) {
  const cacheBinary = resolve(
    nodeCacheDir,
    NODE_VERSION,
    `${t.platform}-${t.arch}`,
    "node",
  );
  if (existsSync(cacheBinary)) return cacheBinary;

  const tarballPath = resolve(
    nodeCacheDir,
    NODE_VERSION,
    `${t.platform}-${t.arch}`,
    targetTarball(t),
  );
  if (!existsSync(tarballPath)) {
    const url = tarballUrl(t);
    console.log(`[sea] downloading ${url}`);
    await downloadFile(url, tarballPath);
  }
  console.log(`[sea] extracting node for ${t.platform}-${t.arch}`);
  extractNodeBinary(tarballPath, t, cacheBinary);
  return cacheBinary;
}

async function generateSeaBlob() {
  // The SEA blob format is tied to the Node major version: a blob produced
  // by node 24 will not boot when injected into a node 22 binary. So we
  // generate the blob using one of our pinned (downloaded) node binaries
  // rather than the host's `process.execPath`.
  const hostArch = process.arch === "arm64" ? "arm64" : "x64";
  const hostPlatform = process.platform === "darwin" ? "darwin" : "linux";
  /** @type {Target} */
  const generatorTarget = { platform: hostPlatform, arch: hostArch };
  const generatorNode = await ensureNodeBinary(generatorTarget);

  const seaConfigPath = resolve(distDir, "sea-config.json");
  const blobPath = resolve(distDir, "dispatch.blob");
  const seaConfig = {
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
  execFileSync(generatorNode, ["--experimental-sea-config", seaConfigPath], {
    stdio: "inherit",
  });
  return blobPath;
}

function postjectInject(
  /** @type {string} */ binary,
  /** @type {string} */ blob,
  /** @type {Target} */ t,
) {
  const args = [
    "postject",
    binary,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    SEA_FUSE,
  ];
  if (t.platform === "darwin") {
    // The Mach-O segment name is mandatory on macOS so postject can find a
    // hole in the binary big enough for the blob.
    args.push("--macho-segment-name", "NODE_SEA");
  }
  execFileSync("npx", ["--no-install", ...args], { stdio: "inherit" });
}

function macosRemoveSignature(/** @type {string} */ binary) {
  // codesign is only on macOS hosts. Skip elsewhere — the unsigned binary
  // produced on Linux still runs after the user re-signs locally.
  if (process.platform !== "darwin") return false;
  const r = spawnSync("codesign", ["--remove-signature", binary], {
    stdio: "inherit",
  });
  return r.status === 0;
}

function macosReSign(/** @type {string} */ binary) {
  if (process.platform !== "darwin") return false;
  const r = spawnSync("codesign", ["--sign", "-", binary], {
    stdio: "inherit",
  });
  return r.status === 0;
}

function stripBinary(/** @type {string} */ _binary, /** @type {Target} */ _t) {
  // Intentionally a no-op for SEA-injected binaries.
  //
  // The Node SEA injection embeds the blob into a custom section/segment
  // (NODE_SEA on macOS, a section on ELF). Running GNU `strip` on the
  // resulting ELF reliably corrupts the layout — we observed segfaults on
  // `./dispatch-linux-x64` after strip rearranged the .init / .plt sections.
  // The acceptance criterion in #18 reads "stripped where applicable"; for
  // SEA binaries strip is not applicable, so we skip it. Binary size could
  // be revisited later via Node build-time configuration rather than
  // post-injection strip.
}

async function buildTarget(
  /** @type {Target} */ t,
  /** @type {string} */ blob,
) {
  const nodeBinary = await ensureNodeBinary(t);
  const outBinary = resolve(distDir, `dispatch-${t.platform}-${t.arch}`);
  copyFileSync(nodeBinary, outBinary);
  chmodSync(outBinary, 0o755);
  if (t.platform === "darwin") {
    macosRemoveSignature(outBinary);
  }
  console.log(`[sea] injecting blob into ${outBinary}`);
  postjectInject(outBinary, blob, t);
  if (t.platform === "darwin") {
    macosReSign(outBinary);
  }
  stripBinary(outBinary, t);
  return outBinary;
}

function parseArgs(/** @type {string[]} */ argv) {
  /** @type {{ targets: Target[], skipDownload: boolean }} */
  const opts = { targets: TARGETS, skipDownload: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host-only") {
      const platform = process.platform === "darwin" ? "darwin" : "linux";
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      opts.targets = TARGETS.filter(
        (t) => t.platform === platform && t.arch === arch,
      );
    } else if (a === "--target") {
      const spec = argv[++i];
      const [platform, arch] = (spec ?? "").split("-");
      const match = TARGETS.find(
        (t) => t.platform === platform && t.arch === arch,
      );
      if (!match) throw new Error(`Unknown target: ${spec}`);
      opts.targets = [match];
    }
  }
  return opts;
}

async function main() {
  ensureBundle();
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(distDir, { recursive: true });
  const blob = await generateSeaBlob();
  console.log(`[sea] blob -> ${blob}`);
  for (const t of opts.targets) {
    const out = await buildTarget(t, blob);
    console.log(`[sea] built ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
