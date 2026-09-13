import {DataError, EnvironmentError, ensure} from '../errors/index.mts';
import type {Page} from './types.mts';

/** Linear pages at 50 by default and accepts more; issues carry nested connections, so they ask for less. */
export const PAGE_SIZE = 100;
export const ISSUE_PAGE_SIZE = 50;

/**
 * How many labels or relations one issue's page carries inline. Asking for
 * more multiplies Linear's complexity cost by every issue in the page, so an
 * issue that overflows this is finished with its own follow-up request instead:
 * the common issue costs nothing extra, and the hub ticket with sixty links
 * still comes back whole.
 */
export const NESTED_PAGE_SIZE = 50;

/**
 * The bound on one walk. Cursors are checked for advancing, so this is the
 * backstop for a connection that repeats itself in a way a single cursor
 * comparison cannot see: at these page sizes, 100,000 projects or 50,000
 * issues in one project. A project past that has to be read as deltas.
 */
export const MAX_PAGES = 1000;

/** A connection as it arrives, before anything has checked that it is whole. */
export interface RawPage<TNode> {
  nodes?: TNode[] | null;
  pageInfo?: {hasNextPage?: boolean; endCursor?: string | null} | null;
}

export function buildMalformedError(connection: string): EnvironmentError {
  return new EnvironmentError(
    `linear answered without the ${connection} it was asked for`,
    {
      hint: "retry the scan; if it repeats, either something is answering in Linear's place or the query names a connection Linear no longer has.",
    }
  );
}

/**
 * One page of a connection, refusing a response that cannot say whether more
 * follow. Every query here selects `nodes` and `pageInfo`, so an absent one
 * means a malformed answer — and reading that as "no further pages" would turn
 * a broken response into a short list the caller has no reason to doubt.
 */
export function readPage<TNode>(
  raw: RawPage<TNode> | null | undefined,
  connection: string
): Page<TNode> {
  const nodes = raw?.nodes;
  const info = raw?.pageInfo;
  ensure(Array.isArray(nodes), () => buildMalformedError(connection));
  ensure(info !== null && info !== undefined, () =>
    buildMalformedError(connection)
  );
  // `hasNextPage` is the one field whose absence has to be refused rather than
  // read as `false`: a page that cannot say whether more follow ends the walk
  // and hands back whatever was collected so far as the whole answer.
  ensure(typeof info.hasNextPage === 'boolean', () =>
    buildMalformedError(connection)
  );
  return {
    nodes,
    pageInfo: {
      hasNextPage: info.hasNextPage,
      endCursor: info.endCursor ?? null,
    },
  };
}

/**
 * Walk a connection to its end, either from the start or on from a page already
 * in hand.
 *
 * The cursor checks are not paranoia about Linear: a page that reports more
 * pages but cannot say where to resume is an infinite loop inside a server
 * tick, and a loop that reports itself is worth the few lines.
 */
export async function collectPages<TNode>(
  load: (after: string | null) => Promise<Page<TNode>>,
  first?: Page<TNode>
): Promise<TNode[]> {
  const all: TNode[] = [];
  let after: string | null = null;
  let current = first;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    current ??= await load(after);
    all.push(...current.nodes);
    if (!current.pageInfo.hasNextPage) return all;
    const next = current.pageInfo.endCursor;
    ensure(
      next !== null,
      () =>
        new EnvironmentError(
          'linear reported another page but no cursor to read it',
          {
            hint: 'retry the scan; if it repeats, the query asks for a connection Linear cannot page.',
          }
        )
    );
    ensure(
      next !== after,
      () =>
        new EnvironmentError('linear paged without advancing its cursor', {
          hint: 'retry the scan; if it repeats, the query asks for a connection Linear cannot page.',
        })
    );
    after = next;
    current = undefined;
  }
  throw new DataError(
    `linear was still paging after ${String(MAX_PAGES)} pages`,
    {
      hint: 'scan a narrower project, or pass a cursor so the delta is smaller.',
    }
  );
}
