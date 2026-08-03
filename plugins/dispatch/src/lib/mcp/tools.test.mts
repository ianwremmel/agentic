import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {discover} from '../command/index.mts';
import {buildTools} from './tools.mts';

const FIXTURES = new URL('../command/__fixtures__/commands/', import.meta.url);

describe('buildTools', () => {
  it('names tools by underscore-joined path and emits one per runnable node', async () => {
    const {defs} = buildTools(await discover(FIXTURES));
    const names = defs.map((d) => d.name);
    assert.ok(names.includes('greet'));
    assert.ok(names.includes('store'));
    assert.ok(names.includes('store_get'));
    assert.ok(names.includes('math_add'));
  });

  it('includes a cli-opted-out command but excludes an mcp-opted-out one', async () => {
    const {defs, byName} = buildTools(await discover(FIXTURES));
    const names = defs.map((d) => d.name);
    assert.ok(names.includes('mcp-only')); // cli:false, still on mcp
    assert.ok(!names.includes('cli-only')); // mcp:false, excluded
    assert.equal(byName.get('math_add')?.name, 'add');
  });

  it('maps options to a JSON Schema with types, enum, default, and required', async () => {
    const {defs} = buildTools(await discover(FIXTURES));
    const greet = defs.find((d) => d.name === 'greet');
    assert.ok(greet);
    const who = greet.inputSchema.properties.who;
    const format = greet.inputSchema.properties.format;
    assert.ok(who);
    assert.ok(format);
    assert.equal(who.type, 'string');
    assert.equal(who.default, 'world');
    assert.deepEqual(format.enum, ['text', 'json']);
    assert.equal(greet.inputSchema.required, undefined); // both greet options optional

    const add = defs.find((d) => d.name === 'math_add');
    assert.deepEqual(add?.inputSchema.required, ['a', 'b']);
  });
});
