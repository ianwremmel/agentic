import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_KINDS, type EventKind } from "../state/event.mts";

/**
 * The resolved built-in prompt template for a single event kind.
 *
 * `path` is the logical asset path the template was loaded from — either an
 * `sea:` URI when running inside the SEA binary, or the on-disk
 * `src/prompts/built-in/<event>.xml` path under dev/test. `content` is the
 * raw XML body of the template; placeholders are evaluated by the caller.
 */
export interface BuiltinPrompt {
  source: "built-in";
  path: string;
  content: string;
}

/** Asset key (and SEA `assets` map key) for a given event kind. */
function assetKeyFor(event: EventKind): string {
  return `prompts/built-in/${event}.xml`;
}

/** Filesystem fallback when running outside of SEA (dev / test / `node`). */
function fsPathFor(event: EventKind): string {
  // Tests and dev runs read from the source tree directly; the SEA binary
  // never hits this branch because `sea.isSea()` returns true there.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "built-in", `${event}.xml`);
}

interface SeaModule {
  isSea?: () => boolean;
  getAsset?: (key: string, encoding?: string) => string | ArrayBuffer;
}

function getSeaModule(): SeaModule | null {
  // `node:sea` is only present in Node ≥ 21.7 and only meaningful inside a
  // SEA binary. Outside of SEA, `isSea()` returns false, so we transparently
  // fall back to the filesystem.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("node:sea") as SeaModule;
    if (typeof mod.isSea === "function" && mod.isSea()) return mod;
    return null;
  } catch {
    return null;
  }
}

/**
 * Return the built-in default prompt template for a dispatch event kind.
 *
 * In a SEA build the content is read from the binary's embedded asset map
 * (see `scripts/sea.mjs#generateSeaBlob`). Outside SEA it falls back to the
 * checked-in `src/prompts/built-in/<event>.xml` files so dev runs and unit
 * tests don't depend on a SEA build step.
 */
export function getBuiltinPrompt(event: EventKind): BuiltinPrompt {
  const key = assetKeyFor(event);
  const sea = getSeaModule();
  if (sea?.getAsset) {
    const raw = sea.getAsset(key, "utf8");
    const content = typeof raw === "string" ? raw : Buffer.from(raw).toString();
    return { source: "built-in", path: `sea:${key}`, content };
  }
  const fsPath = fsPathFor(event);
  const content = readFileSync(fsPath, "utf8");
  return { source: "built-in", path: fsPath, content };
}

/**
 * The asset map embedded into the SEA blob at build time — exported so
 * `scripts/sea.mjs` can derive the `assets` field of `sea-config.json` from
 * the same single source of truth as the runtime resolver. Each key is the
 * SEA asset name (matching `assetKeyFor`); the value is the on-disk path
 * relative to the repository root.
 */
export function builtinPromptAssetMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kind of EVENT_KINDS) {
    // Paths are repo-relative so `scripts/sea.mjs` can resolve them against
    // the project root without needing to know about ESM URL resolution.
    out[assetKeyFor(kind)] = `src/prompts/built-in/${kind}.xml`;
  }
  return out;
}
