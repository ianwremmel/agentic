#!/usr/bin/env node
// PreToolUse hook: deny launching a dispatch worker agent unless the session
// holds a live claim on a node the launch prompt names.
//
// The harness executes this before the tool call runs, so no instruction to
// the model — from a supervisor, an operator note, or a future skill edit —
// can skip it. That is the property the in-agent `claim check` cannot have:
// it only runs if the worker chooses to run it.
//
// All judgment lives in `dispatch claim guard`; this file only parses the
// hook payload, scopes the rule to the plugin's own worker agents, and
// relays the verdict.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

/** The agent types the scheduler dispatches; nothing else is gated. */
const WORKERS = new Set([
  'dispatch:pr-worker',
  'dispatch:ticket-worker',
  'dispatch:milestone-reviewer',
  // Bare names, as a harness may strip the plugin prefix.
  'pr-worker',
  'ticket-worker',
  'milestone-reviewer',
]);

const deny = (reason: string): void => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
};

interface HookPayload {
  tool_input?: {
    subagent_type?: string;
    agent_type?: string;
    prompt?: string;
  };
}

let payload: unknown;
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  // An unreadable payload gives no way to tell a worker launch from anything
  // else. Failing closed here would break every tool call in the session, so
  // the gate only fails closed once it knows a worker is being launched.
  process.exit(0);
}

// Valid JSON of the wrong shape (null, a number) is as unreadable as a
// parse failure and gets the same treatment.

const input =
  payload !== null && typeof payload === 'object'
    ? ((payload as HookPayload).tool_input ?? {})
    : {};
const agentType = input.subagent_type ?? input.agent_type ?? '';
if (!WORKERS.has(agentType)) process.exit(0);

const prompt = typeof input.prompt === 'string' ? input.prompt : '';
// From here on the launch is a worker launch, and failure is denial: a guard
// that fails open for the case it exists for is not a guard.
const bin = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'dispatch'
);
const result = spawnSync(bin, ['claim', 'guard'], {
  input: prompt,
  encoding: 'utf8',
  timeout: 10_000,
});
if (result.status === 0) process.exit(0);
deny(
  `dispatch refused this ${agentType} launch: ${(
    result.stderr ||
    result.stdout ||
    'claim guard did not run'
  )
    .trim()
    .split('\n')
    .slice(0, 3)
    .join(
      ' '
    )} Workers are launched from work orders, which name a node the scheduler already claimed.`
);
