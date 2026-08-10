import {AbstractCommand} from '../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../lib/command/index.mts';
import {DB_OPTION, withDatabase} from '../lib/db/index.mts';
import {derive, dispatchQueue, repoPrLoad} from '../lib/graph/index.mts';
import {RepoAdmission} from '../lib/schedule/index.mts';
import {PolicyStore} from '../lib/stores/index.mts';

const options = {
  project: {
    type: 'string',
    description:
      'Restrict the report to one project id. Anomalies are graph-wide and stay unfiltered.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

export class Command extends AbstractCommand {
  readonly name = 'status';
  readonly summary =
    'Print per-project counts, milestone gates, anomalies, and the terminal verdict.';
  readonly env = [];
  readonly options = options;

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    await withDatabase(parsed.db, ctx.env, async (db) => {
      const graph = await derive(db, {project: parsed.project});

      for (const counts of graph.counts) {
        ctx.io.write(
          `project ${counts.project} total=${String(counts.total)} ` +
            `available=${String(counts.available)} blocked=${String(counts.blocked)} ` +
            `human-blocked=${String(counts.humanBlocked)} in-flight=${String(counts.inFlight)} ` +
            `dormant=${String(counts.dormant)} verified=${String(counts.verified)} ` +
            `canceled=${String(counts.canceled)} terminal=${String(counts.terminal)}\n`
        );
      }
      for (const milestone of graph.milestones) {
        ctx.io.write(
          `milestone ${milestone.id} project=${milestone.project} ` +
            `members=${String(milestone.memberCount)} unresolved=${String(milestone.openCount)} ` +
            `ready-for-review=${String(milestone.readyForReview)} ` +
            `review-recorded=${String(milestone.reviewRecorded)} open=${String(milestone.open)}\n`
        );
      }
      for (const entry of graph.prs) {
        ctx.io.write(
          `pr ${entry.item.id}` +
            (entry.item.ticket === null ? '' : ` ticket=${entry.item.ticket}`) +
            ` ${entry.classification}\n`
        );
      }
      // Why the queue is idle when it is: a repo at one of its caps holds
      // work back with nothing else to show for it, which otherwise reads as
      // a wedged system.
      const admission = new RepoAdmission(
        await new PolicyStore(db).getRepoCaps(),
        await repoPrLoad(db)
      );
      for (const {entry} of await dispatchQueue(db, {
        project: parsed.project,
      })) {
        if (entry.item.kind === 'pr') admission.admit(entry.item);
      }
      for (const hold of admission.holds()) {
        ctx.io.write(
          `cap-hold ${hold.repo} ${hold.cap}=${String(hold.observed)}/${String(hold.limit)} ` +
            `waiting=${String(hold.waiting)}\n`
        );
      }
      for (const anomaly of graph.anomalies) {
        ctx.io.write(`anomaly ${anomaly.kind} ${anomaly.detail}\n`);
      }
      ctx.io.write(`terminal=${String(graph.terminal)}\n`);
    });
  }
}
