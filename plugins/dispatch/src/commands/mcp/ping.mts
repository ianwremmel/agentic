import {randomUUID} from 'node:crypto';

import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';

const options = {
  nonce: {
    type: 'string',
    description:
      'Token to echo back; one is generated when omitted. Match it against the pong to be sure they are the same round trip.',
    positional: false,
    required: false,
  },
} as const;

/**
 * Ask the server to push a `pong` into the session, and report the nonce it
 * used. Whether that pong arrives is the whole answer to "does this channel
 * work".
 *
 * Everything else the server pushes is indirect evidence. A probe goes
 * unanswered for two indistinguishable reasons — the runner never delivered
 * it, or the session received it and did nothing — and an unacknowledged
 * session row cannot tell them apart. This can: the tool result proves the
 * call reached the server, so a missing pong isolates the failure to
 * delivery.
 *
 * Over the CLI there is no session to push to, and the command says so rather
 * than pretending to test anything.
 */
export class Command extends AbstractCommand {
  readonly name = 'ping';
  readonly summary =
    'Push a pong through the channel to prove it reaches the session.';
  readonly env = [];
  readonly options = options;

  // eslint-disable-next-line @typescript-eslint/require-await -- the contract is async; this command only writes
  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const nonce = parsed.nonce ?? randomUUID();

    if (ctx.channel === undefined) {
      ctx.io.write(
        `ping ${nonce} no-channel\nThis ran outside an MCP server, so there is no session to push to. Call the \`mcp_ping\` tool instead.\n`
      );
      return;
    }

    ctx.channel.push(
      'pong',
      {nonce},
      `pong ${nonce} — this text was pushed over the channel, not returned by the tool call. Seeing it proves the channel reaches this session.`
    );
    ctx.io.write(
      `ping ${nonce} pushed\nA pong carrying nonce ${nonce} went out over the channel. If it does not appear, the runner is not delivering channel events and every push the server makes is being dropped.\n`
    );
  }
}
