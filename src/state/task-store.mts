import { open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeTaskId } from "./encoding.mts";
import { layoutForRoot, type StateLayout } from "./paths.mts";
import { isTaskRecord, type TaskRecord } from "./task-record.mts";

export interface TaskStoreOptions {
  /** State root directory. Caller is responsible for ensuring it exists. */
  root: string;
}

export class TaskStore {
  private readonly layout: StateLayout;

  constructor(opts: TaskStoreOptions) {
    this.layout = layoutForRoot(opts.root);
  }

  /** Returns the parsed record, or `null` if not present. */
  async read(id: string): Promise<TaskRecord | null> {
    const path = this.layout.taskFile(id);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isTaskRecord(parsed)) {
      throw new Error(`task record at ${path} is malformed`);
    }
    return parsed;
  }

  /**
   * Atomically writes `record` to `tasks/<encoded-id>.json` via
   * write-temp+fsync+rename. The temp file uses a unique-per-call suffix
   * so concurrent writers for the same ID cannot trash each other's tmp.
   */
  async write(record: TaskRecord): Promise<void> {
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new Error("task record requires a non-empty id");
    }
    const finalPath = this.layout.taskFile(record.id);
    await mkdir(dirname(finalPath), { recursive: true });

    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const body = `${JSON.stringify(record, null, 2)}\n`;

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
      // best-effort cleanup; do not mask the rename error
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** Removes the record. Missing files are a no-op. */
  async delete(id: string): Promise<void> {
    const path = this.layout.taskFile(id);
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  /**
   * Returns every fully-written task record. Files ending in `.tmp.*` (or any
   * non-`.json` suffix) are silently ignored — those are partial writes from a
   * crashed `write()` and will be replaced or cleaned up later.
   */
  async list(): Promise<TaskRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.layout.tasksDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: TaskRecord[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const encoded = name.slice(0, -".json".length);
      let id: string;
      try {
        id = decodeTaskId(encoded);
      } catch {
        continue;
      }
      const rec = await this.read(id);
      if (rec !== null) out.push(rec);
    }
    return out;
  }

  /** Exposes the absolute path for a given ID. */
  pathFor(id: string): string {
    return this.layout.taskFile(id);
  }
}

export function openTaskStore(opts: TaskStoreOptions): TaskStore {
  return new TaskStore(opts);
}

export const TASKS_DIR_NAME = "tasks";

export { isTaskRecord };
export type { TaskRecord };
