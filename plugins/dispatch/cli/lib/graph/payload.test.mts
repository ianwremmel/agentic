import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataError} from '../errors.mts';
import {DEFAULT_CONFIG, type GraphConfig} from './config.mts';
import {parsePayload} from './payload.mts';

const options = {tracker: 'linear', config: DEFAULT_CONFIG, source: 'linear'};

function parse(payload: unknown, config: GraphConfig = DEFAULT_CONFIG) {
  return parsePayload(payload, {...options, config});
}

/** The message and the hint both matter: an agent reads them to fix its own output. */
function rejects(payload: unknown, message: RegExp, hint?: RegExp): void {
  assert.throws(
    () => parse(payload),
    (error: unknown) => {
      assert.ok(error instanceof DataError);
      assert.match(error.message, message);
      if (hint !== undefined) assert.match(String(error.hint), hint);
      return true;
    }
  );
}

describe('normalizing a fetch', () => {
  it('maps a native tracker state onto a protocol role', () => {
    const delta = parse({
      nodes: [{id: 'CLC-1', project: 'P', state: 'In Review'}],
    });

    assert.equal(delta.nodes[0]?.role, 'in-review');
  });

  it('takes a resolved role over a native state: an adapter that knows the mapping is not second-guessed', () => {
    const delta = parse({
      nodes: [{id: 'CLC-1', project: 'P', state: 'Done', role: 'delivered'}],
    });

    assert.equal(delta.nodes[0]?.role, 'delivered');
  });

  it('accepts snake_case as readily as camelCase', () => {
    const delta = parse({
      nodes: [
        {
          id: 'CLC-1',
          project: 'P',
          role: 'available',
          human_interactive: true,
          branch_hint: 'clc-1-thing',
          blocked_by: ['CLC-0'],
          updated_at: '2026-07-11T00:00:00.000Z',
        },
      ],
    });

    const first = delta.nodes[0];
    assert.ok(first);
    assert.equal(first.humanInteractive, true);
    assert.equal(first.branchHint, 'clc-1-thing');
    assert.deepEqual(first.blockedBy, ['CLC-0']);
  });

  it('derives target kind and the human flag from configured labels', () => {
    const config: GraphConfig = {
      ...DEFAULT_CONFIG,
      humanInteractiveLabels: ['needs-human'],
      verificationLabels: ['qa'],
    };

    const delta = parse(
      {
        nodes: [
          {id: 'A', project: 'P', role: 'available', labels: ['QA']},
          {id: 'B', project: 'P', role: 'available', labels: ['needs-human']},
          {id: 'C', project: 'P', role: 'available', labels: ['chore']},
        ],
      },
      config
    );

    const [qa, human, chore] = delta.nodes;
    assert.ok(qa && human && chore);
    assert.equal(qa.targetKind, 'verification');
    assert.equal(human.targetKind, 'human-only');
    assert.equal(human.humanInteractive, true);
    assert.equal(chore.targetKind, 'pr');
    assert.equal(chore.humanInteractive, false);
  });

  it('distinguishes an absent edge list from an empty one', () => {
    // Absent means "this fetch says nothing"; empty means "there are none". The
    // store relies on the difference to know whether to drop existing edges.
    const delta = parse({
      nodes: [
        {id: 'A', project: 'P', role: 'available'},
        {id: 'B', project: 'P', role: 'available', blockedBy: []},
      ],
    });

    assert.equal(delta.nodes[0]?.blockedBy, undefined);
    assert.deepEqual(delta.nodes[1]?.blockedBy, []);
  });

  it('needs only an id to delete a ticket', () => {
    const delta = parse({nodes: [{id: 'A', deleted: true}]});

    assert.equal(delta.nodes[0]?.deleted, true);
  });

  it('reads the cursor, whichever spelling the adapter used', () => {
    assert.deepEqual(parse({cursor: 'X', nodes: []}).cursors, {linear: 'X'});
    assert.deepEqual(parse({cursors: {jira: 'Y'}, nodes: []}).cursors, {
      jira: 'Y',
    });
  });
});

describe('rejecting a payload an agent got wrong', () => {
  it('rejects a string where a boolean belongs, rather than reading it as false', () => {
    // "true" read as false would turn a deletion into a resurrection.
    rejects(
      {nodes: [{id: 'A', project: 'P', role: 'available', deleted: 'true'}]},
      /must be true or false/,
      /never \{"deleted": "true"\}/
    );
  });

  it('rejects a milestone object where an id belongs, rather than dropping the ticket out of its milestone', () => {
    // {"milestone": {"id": "m1"}} is the shape Linear's API actually returns.
    // Coerced to a string it would stringify to garbage; read as null it would
    // silently escape the milestone gate.
    rejects(
      {
        nodes: [
          {id: 'A', project: 'P', role: 'available', milestone: {id: 'm1'}},
        ],
      },
      /milestone must be a string, but got an object/,
      /not \{"id": "m1"\}/
    );
  });

  it('rejects a native state no mapping covers instead of guessing at it', () => {
    rejects(
      {nodes: [{id: 'A', project: 'P', state: 'Ready for QA'}]},
      /no mapping for the native state "Ready for QA"/,
      /do not guess/
    );
  });

  it('rejects a node with neither a role nor a state', () => {
    rejects(
      {nodes: [{id: 'A', project: 'P'}]},
      /neither a "role" nor a native "state"/
    );
  });

  it('rejects a role that is not in the protocol vocabulary', () => {
    rejects(
      {nodes: [{id: 'A', project: 'P', role: 'wip'}]},
      /"wip", which is not a protocol role/,
      /in-progress/
    );
  });

  it('rejects a milestone with no sortOrder, which would leave the gate order unknown', () => {
    rejects(
      {milestones: [{id: 'm1', project: 'P', name: 'One'}], nodes: []},
      /milestone m1 has no sortOrder/,
      /decides which milestones gate which/
    );
  });

  it('names the ticket it choked on', () => {
    rejects(
      {
        nodes: [
          {id: 'A', project: 'P', role: 'available'},
          {id: 'CLC-77', project: 'P', role: 'available', labels: 'urgent'},
        ],
      },
      /node CLC-77\.labels must be an array of strings/
    );
  });
});

describe('a team override', () => {
  it('maps a state the tracker default has never heard of', () => {
    const config: GraphConfig = {
      ...DEFAULT_CONFIG,
      states: {'Ready for QA': 'in-review'},
    };

    const delta = parse(
      {nodes: [{id: 'A', project: 'P', state: 'ready for qa'}]},
      config
    );

    assert.equal(delta.nodes[0]?.role, 'in-review');
  });
});
