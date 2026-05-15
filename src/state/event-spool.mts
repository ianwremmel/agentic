import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeTaskId, encodeTaskId } from "./encoding.mts";
import { layoutForRoot, type StateLayout } from "./paths.mts";
import { isDispatchEvent, isRfc3339Utc, type DispatchEvent } from "./event.mts";

export interface EventSpoolOptions {
  /** State root directory. Caller is responsible for ensuring it exists. */
  root: string;
}

/** A spooled event paired with the filename used to locate it on disk. */
export interface SpooledEvent {
  filename: string;
  event: DispatchEvent;
}

export class EventSpool {
  private readonly layout: StateLayout;

  constructor(opts: EventSpoolOptions) {
    this.layout = layoutForRoot(opts.root);
  }

  /**
   * Atomically writes the event under `events/<timestamp>-<encoded-id>.json`
   * and returns the filename (basename) so the caller can dequeue it later.
   *
   * The timestamp comes from the event itself, not wallclock-at-write,
   * because the event's source (the poller, the runner-exit hook, etc.)
   * already chose a canonical timestamp and that's what determines ordering.
   */
  async enqueue(event: DispatchEvent): Promise<string> {
    if (!isDispatchEvent(event)) {
      throw new Error("event does not match the DispatchEvent shape");
    }
    if (!isRfc3339Utc(event.timestamp)) {
      throw new Error(
        `event.timestamp must be RFC 3339 UTC ("...Z"), got ${event.timestamp}`,
      );
    }
    const filename = buildEventFilename(event.timestamp, event.task_id);
    const finalPath = join(this.layout.eventsDir, filename);
    await mkdir(dirname(finalPath), { recursive: true });

    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const body = `${JSON.stringify(event, null, 2)}\n`;

    const handle = await open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmpPath, finalPath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
    return filename;
  }

  /**
   * Returns every fully-written event in chronological (== lexicographic
   * filename) order. Partial-write tmp files and undecodable filenames are
   * silently skipped.
   */
  async drain(): Promise<SpooledEvent[]> {
    let entries: string[];
    try {
      entries = await readdir(this.layout.eventsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const usable: string[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      if (name.includes(".tmp.")) continue;
      usable.push(name);
    }
    usable.sort();

    const out: SpooledEvent[] = [];
    for (const name of usable) {
      const fullPath = join(this.layout.eventsDir, name);
      let raw: string;
      try {
        raw = await readFile(fullPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Malformed event file — caller has no way to recover and we don't
        // want a single corrupt file to wedge the daemon on startup. Skip it.
        continue;
      }
      if (!isDispatchEvent(parsed)) continue;
      out.push({ filename: name, event: parsed });
    }
    return out;
  }

  /** Removes a spooled event after the caller has successfully handled it. */
  async dequeue(filename: string): Promise<void> {
    const path = join(this.layout.eventsDir, filename);
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  /** Exposes the absolute path for a spooled filename (debug / testing). */
  pathFor(filename: string): string {
    return join(this.layout.eventsDir, filename);
  }
}

export function openEventSpool(opts: EventSpoolOptions): EventSpool {
  return new EventSpool(opts);
}

/**
 * Builds the canonical event filename. Exposed for tests and for callers
 * that need to predict the filename of an event they're about to enqueue.
 */
export function buildEventFilename(timestamp: string, taskId: string): string {
  return `${timestamp}-${encodeTaskId(taskId)}.json`;
}

/**
 * Reverses {@link buildEventFilename}. Throws on malformed input. Returned
 * timestamp matches the event's `timestamp` field byte-for-byte.
 */
export function parseEventFilename(filename: string): {
  timestamp: string;
  taskId: string;
} {
  if (!filename.endsWith(".json")) {
    throw new Error(`event filename must end in .json: ${filename}`);
  }
  const stem = filename.slice(0, -".json".length);
  // RFC 3339 UTC timestamps are 20 chars without subseconds
  // (YYYY-MM-DDTHH:MM:SSZ) or longer with them. The encoded ID lives after
  // the first `Z-`.
  const sepIndex = stem.indexOf("Z-");
  if (sepIndex < 0) {
    throw new Error(`event filename missing 'Z-' separator: ${filename}`);
  }
  const timestamp = `${stem.slice(0, sepIndex)}Z`;
  const encodedId = stem.slice(sepIndex + 2);
  if (!isRfc3339Utc(timestamp)) {
    throw new Error(`event filename timestamp not RFC 3339 UTC: ${timestamp}`);
  }
  return { timestamp, taskId: decodeTaskId(encodedId) };
}
