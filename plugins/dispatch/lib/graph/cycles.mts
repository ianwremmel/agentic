/**
 * Cycle detection. Dependency cycles are illegal, and a cycle silently worked
 * around would deadlock a run, so they are found and surfaced, never repaired.
 */

/**
 * Every cycle in a directed graph, via an iterative Tarjan (iterative because a
 * deep dependency chain would blow a recursive stack).
 *
 * @param ids every node, so isolated nodes are visited too
 * @param next successors of a node
 * @returns one sorted id list per cycle; a self-edge counts as a cycle of one
 */
export function findCycles(ids: Iterable<string>, next: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  for (const root of ids) {
    if (index.has(root)) continue;
    const work: Array<[string, number]> = [[root, 0]];

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const [v, i] = frame;

      if (i === 0) {
        index.set(v, counter);
        low.set(v, counter);
        counter += 1;
        stack.push(v);
        onStack.add(v);
      }

      const successors = next.get(v) ?? [];
      if (i < successors.length) {
        frame[1] += 1;
        const w = successors[i]!;
        if (!index.has(w)) work.push([w, 0]);
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        continue;
      }

      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]![0];
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }

      // v roots a strongly connected component: pop it off the stack.
      if (low.get(v) === index.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        const selfEdge = (next.get(v) ?? []).includes(v);
        if (component.length > 1 || selfEdge) cycles.push(component.sort());
      }
    }
  }

  return cycles;
}
