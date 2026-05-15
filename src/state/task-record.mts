export interface TaskRecord {
  id: string;
  worktree: string;
  head: string | null;
  session_id: string | null;
  subscriptions: ReadonlyArray<number | string>;
  last_heartbeat: string | null;
  live_runner_pid: number | null;
  pending_followup: Record<string, unknown> | null;
  [extra: string]: unknown;
}

export function isTaskRecord(value: unknown): value is TaskRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return false;
  if (typeof v.worktree !== "string") return false;
  if (!Array.isArray(v.subscriptions)) return false;
  return true;
}
