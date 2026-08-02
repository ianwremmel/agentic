import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ChannelWriter} from './channel.mts';

interface Notification {
  params: {meta: Record<string, string>};
}

describe('ChannelWriter', () => {
  it('drops a meta key that fails the identifier shape, and never emits source', () => {
    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );

    channel.push(
      'scan_project',
      {tracker: 'linear', 'bad-key': 'x', source: 'evil'},
      'body'
    );

    const [first] = sent;
    assert.ok(first);
    const {meta} = first.params;
    assert.equal(meta.tracker, 'linear');
    assert.equal(meta['bad-key'], undefined);
    assert.equal(meta.source, undefined);
  });

  it('increases seq across successive pushes and never repeats it', () => {
    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );

    channel.push('scan_project', {}, 'a');
    channel.push('scan_project', {}, 'b');
    channel.push('scan_project', {}, 'c');

    const seqs = sent.map((n) => n.params.meta.seq);
    assert.deepEqual(seqs, ['1', '2', '3']);
    assert.equal(new Set(seqs).size, seqs.length);
  });
});
