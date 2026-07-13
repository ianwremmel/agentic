import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CONFIG } from '../config.mts';
import { DataError, UsageError } from '../errors.mts';
import { parsePayload } from './payload.mts';

const options = { tracker: 'linear', config: DEFAULT_CONFIG, source: 'linear' };

const minimal = (overrides: Record<string, unknown> = {}) => ({
  id: 'CLC-1',
  project: 'p1',
  state: 'Todo',
  ...overrides,
});

describe('state mapping', () => {
  it('maps a native tracker state onto a protocol role', () => {
    const delta = parsePayload(
      { nodes: [minimal({ state: 'In Review' })] },
      options,
    );

    assert.equal(delta.nodes[0]?.role, 'in-review');
  });

  it("maps Linear's Duplicate state to canceled", () => {
    // Linear exposes `duplicate` as a status type of its own. It means the work
    // will not be done, which is the `canceled` role — and it must not trip the
    // unmapped-state error on a workspace that uses it.
    const delta = parsePayload(
      { nodes: [minimal({ state: 'Duplicate' })] },
      options,
    );

    assert.equal(delta.nodes[0]?.role, 'canceled');
  });

  it('refuses to guess at a state it has no mapping for', () => {
    // Guessing wrong here silently strands or double-dispatches real work, so
    // the CLI stops and tells the agent exactly how to resolve it.
    assert.throws(
      () =>
        parsePayload({ nodes: [minimal({ state: 'Ready for QA' })] }, options),
      (error: unknown) => {
        assert.ok(error instanceof DataError);
        assert.match(
          error.message,
          /no mapping for the native state "Ready for QA"/,
        );
        assert.match(
          error.remedy,
          /add it to the config file's "states" object/,
        );
        assert.match(error.remedy, /do not guess/i);
        return true;
      },
    );
  });

  it('lets a team override beat the default mapping', () => {
    const delta = parsePayload(
      { nodes: [minimal({ state: 'Ready for QA' })] },
      {
        ...options,
        config: { ...DEFAULT_CONFIG, states: { 'ready for qa': 'in-review' } },
      },
    );

    assert.equal(delta.nodes[0]?.role, 'in-review');
  });

  it('takes an adapter-resolved role over the native state', () => {
    const delta = parsePayload(
      { nodes: [minimal({ state: 'Todo', role: 'delivered' })] },
      options,
    );

    assert.equal(delta.nodes[0]?.role, 'delivered');
  });

  it('rejects a node carrying neither a role nor a state', () => {
    assert.throws(
      () => parsePayload({ nodes: [{ id: 'CLC-1', project: 'p1' }] }, options),
      UsageError,
    );
  });
});

describe('labels', () => {
  it('reads a human-interactive label as work only a human may do', () => {
    const delta = parsePayload(
      { nodes: [minimal({ labels: ['Human-Led'] })] },
      options,
    );

    assert.equal(delta.nodes[0]?.humanInteractive, true);
    assert.equal(delta.nodes[0]?.targetKind, 'human-only');
  });

  it('reads a verification label as a no-PR verification', () => {
    const delta = parsePayload(
      { nodes: [minimal({ labels: ['verification'] })] },
      options,
    );

    assert.equal(delta.nodes[0]?.targetKind, 'verification');
    assert.equal(delta.nodes[0]?.humanInteractive, false);
  });

  it('lets an explicit target kind override what the labels imply', () => {
    const delta = parsePayload(
      { nodes: [minimal({ labels: ['human-led'], targetKind: 'pr' })] },
      options,
    );

    assert.equal(delta.nodes[0]?.targetKind, 'pr');
  });

  it('defaults to a PR when no label says otherwise', () => {
    const delta = parsePayload(
      { nodes: [minimal({ labels: ['bug'] })] },
      options,
    );

    assert.equal(delta.nodes[0]?.targetKind, 'pr');
  });
});

describe('edges', () => {
  it('accepts both directions and drops a self-edge', () => {
    // A ticket cannot depend on itself. The tracker should never emit one, but
    // taking it at face value would make the ticket permanently block itself.
    const delta = parsePayload(
      {
        nodes: [
          minimal({
            blockedBy: ['CLC-9', 'CLC-1'],
            blocks: ['CLC-2', 'CLC-1'],
          }),
        ],
      },
      options,
    );

    assert.deepEqual(delta.nodes[0]?.blockedBy, ['CLC-9']);
    assert.deepEqual(delta.nodes[0]?.blocks, ['CLC-2']);
  });

  it('distinguishes "no edges" from "this fetch says nothing about edges"', () => {
    // An empty array clears the node's edges in that direction; an absent key
    // leaves them alone. Conflating the two would silently drop dependencies on
    // any adapter that fetches relations separately from issues.
    const cleared = parsePayload(
      { nodes: [minimal({ blockedBy: [] })] },
      options,
    );
    assert.deepEqual(cleared.nodes[0]?.blockedBy, []);

    const silent = parsePayload({ nodes: [minimal()] }, options);
    assert.equal(silent.nodes[0]?.blockedBy, undefined);
  });

  it('accepts snake_case keys from a hand-written payload', () => {
    const delta = parsePayload(
      {
        nodes: [
          minimal({
            blocked_by: ['CLC-9'],
            branch_hint: 'clc-1-x',
            updated_at: 'T',
          }),
        ],
      },
      options,
    );

    assert.deepEqual(delta.nodes[0]?.blockedBy, ['CLC-9']);
    assert.equal(delta.nodes[0]?.branchHint, 'clc-1-x');
    assert.equal(delta.nodes[0]?.updatedAt, 'T');
  });
});

describe('deletions and cursors', () => {
  it('needs only an id to delete a ticket', () => {
    const delta = parsePayload(
      { nodes: [{ id: 'CLC-1', deleted: true }] },
      options,
    );

    assert.equal(delta.nodes[0]?.deleted, true);
    assert.equal(delta.nodes[0]?.id, 'CLC-1');
  });

  it('files a bare cursor under the source it came from', () => {
    const delta = parsePayload(
      { cursor: '2026-07-11T00:00:00Z', nodes: [] },
      options,
    );

    assert.deepEqual(delta.cursors, { linear: '2026-07-11T00:00:00Z' });
  });
});

describe('milestones', () => {
  it('refuses a milestone with no sort order', () => {
    // Sort order decides which milestone gates which. Defaulting it would put
    // milestones in an arbitrary order and gate the wrong tickets.
    assert.throws(
      () =>
        parsePayload(
          { milestones: [{ id: 'm1', project: 'p1', name: 'M1' }], nodes: [] },
          options,
        ),
      (error: unknown) => {
        assert.ok(error instanceof UsageError);
        assert.match(error.message, /has no sortOrder/);
        return true;
      },
    );
  });
});
