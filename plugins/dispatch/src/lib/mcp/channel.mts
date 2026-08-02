/** The runner drops any meta key outside this shape. */
const META_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

/**
 * Pushes channel events into the session that spawned the server. `source` is
 * the runner's own attribute — a second one on the tag would not override it,
 * so this never sets one.
 */
export class ChannelWriter {
  readonly #emit: (payload: unknown) => void;
  #seq = 0;

  constructor(emit: (payload: unknown) => void) {
    this.#emit = emit;
  }

  push(
    kind: string,
    meta: Readonly<Record<string, string | null>>,
    content: string
  ): void {
    this.#seq += 1;
    const params: Record<string, string> = {kind, seq: String(this.#seq)};
    for (const [key, value] of Object.entries(meta)) {
      if (value === null) continue;
      if (key === 'source' || key === 'kind' || key === 'seq') continue;
      if (!META_KEY.test(key)) continue;
      // `meta` is typed `string | null`, but a caller's payload passed through
      // JSON.parse behind an unchecked cast (`ScanPayload`/`TicketPayload`), so
      // a numeric or boolean field can reach here as its native type despite
      // what the type checker believes at this point.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion
      params[key] = String(value);
    }
    this.#emit({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: {content, meta: params},
    });
  }
}
