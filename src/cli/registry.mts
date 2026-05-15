// The dispatch subcommand registry. Adding a new subcommand is a
// matter of appending one CommandSpec here; the router does the rest.

import { stubs } from "./stubs.mts";
import type { CommandSpec, ParsedArgs } from "./types.mts";

const REACTIONS = ["+1", "-1", "rocket", "eyes"] as const;

// Mutual-exclusion helper for cross-flag validation.
function mutuallyExclusive(
  parsed: ParsedArgs,
  ...names: readonly string[]
): string | null {
  const present = names.filter((n) => {
    const v = parsed.flags[n];
    if (v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.length > 0;
    return v !== "";
  });
  if (present.length > 1) {
    return `flags ${present.map((n) => `--${n}`).join(", ")} are mutually exclusive`;
  }
  return null;
}

function oneOfRequired(
  parsed: ParsedArgs,
  ...names: readonly string[]
): string | null {
  const present = names.some((n) => {
    const v = parsed.flags[n];
    if (v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.length > 0;
    return v !== "";
  });
  if (!present) {
    return `exactly one of ${names.map((n) => `--${n}`).join(", ")} is required`;
  }
  return null;
}

export const commands: readonly CommandSpec[] = [
  // ----- Daemon ------------------------------------------------------
  {
    name: "daemon start",
    summary: "Start the dispatch daemon.",
    flags: [
      {
        name: "foreground",
        kind: "boolean",
        description: "Run in the foreground; do not detach from the TTY.",
      },
    ],
    positionals: [],
    handler: stubs.daemonStart,
  },
  {
    name: "daemon stop",
    summary: "Stop the dispatch daemon.",
    flags: [
      {
        name: "force",
        kind: "boolean",
        description:
          "Send SIGTERM immediately without waiting for in-flight runners.",
      },
    ],
    positionals: [],
    handler: stubs.daemonStop,
  },
  {
    name: "daemon status",
    summary: "Print daemon state and per-task heartbeat summary.",
    flags: [],
    positionals: [],
    handler: stubs.daemonStatus,
  },

  // ----- Prompts -----------------------------------------------------
  {
    name: "prompts list",
    summary: "List event kinds and the winning template for each.",
    flags: [],
    positionals: [],
    handler: stubs.promptsList,
  },
  {
    name: "prompts copy",
    summary:
      "Copy the built-in default for an event to the repo or user override.",
    flags: [
      {
        name: "repo",
        kind: "boolean",
        description: "Write to <cwd>/.dispatch/prompts/<event>.xml.",
      },
      {
        name: "home",
        kind: "boolean",
        description: "Write to ~/.config/dispatch/prompts/<event>.xml.",
      },
      {
        name: "force",
        kind: "boolean",
        description: "Overwrite the target file if it exists.",
      },
    ],
    positionals: [
      {
        name: "event",
        required: true,
        description: "Event kind whose prompt to copy.",
      },
    ],
    validate: (p) =>
      oneOfRequired(p, "repo", "home") ?? mutuallyExclusive(p, "repo", "home"),
    handler: stubs.promptsCopy,
  },
  {
    name: "prompts diff",
    summary: "Show the diff between the active override and the built-in.",
    flags: [],
    positionals: [
      {
        name: "event",
        required: true,
        description: "Event kind to diff.",
      },
    ],
    handler: stubs.promptsDiff,
  },

  // ----- Tasks -------------------------------------------------------
  {
    name: "tasks list",
    summary: "List tasks the daemon is monitoring.",
    flags: [],
    positionals: [],
    handler: stubs.tasksList,
  },
  {
    name: "tasks remove",
    summary: "Stop monitoring a task and remove its worktree if owned.",
    flags: [],
    positionals: [
      {
        name: "url-or-id",
        required: true,
        description: "Task URL or tracker-native ID.",
      },
    ],
    handler: stubs.tasksRemove,
  },
  {
    name: "tasks show",
    summary: "Print the full task record as JSON.",
    flags: [],
    positionals: [
      {
        name: "url-or-id",
        required: true,
        description: "Task URL or tracker-native ID.",
      },
    ],
    handler: stubs.tasksShow,
  },

  // ----- Top-level task ops -----------------------------------------
  {
    name: "add-ticket",
    summary: "Register a ticket for the daemon to monitor.",
    flags: [],
    positionals: [
      {
        name: "url-or-id",
        required: true,
        description: "Ticket URL or tracker-native ID.",
      },
    ],
    handler: stubs.addTicket,
  },
  {
    name: "add-project",
    summary: "Register a tracker project for the daemon to monitor.",
    flags: [],
    positionals: [
      {
        name: "url-or-id",
        required: true,
        description: "Project URL or tracker-native ID.",
      },
    ],
    handler: stubs.addProject,
  },
  {
    name: "add-pr",
    summary: "Register an existing GitHub pull request for monitoring.",
    flags: [],
    positionals: [
      {
        name: "url",
        required: true,
        description: "Full URL to a GitHub pull request.",
      },
    ],
    handler: stubs.addPr,
  },

  // ----- Interaction commands ---------------------------------------
  {
    name: "create-comment",
    summary: "Post a new top-level comment on a PR or ticket.",
    flags: [
      {
        name: "repo",
        kind: "string",
        required: true,
        description: "Repository in <owner>/<repo> form.",
      },
      {
        name: "pr",
        kind: "string",
        description: "PR number (mutually exclusive with --issue).",
      },
      {
        name: "issue",
        kind: "string",
        description: "Issue number (mutually exclusive with --pr).",
      },
      {
        name: "body",
        kind: "string",
        required: true,
        description: "Comment body (opaque).",
      },
      {
        name: "agent-id",
        kind: "string",
        required: true,
        description: "Agent identifier placed in the machine marker.",
      },
    ],
    positionals: [],
    validate: (p) =>
      oneOfRequired(p, "pr", "issue") ?? mutuallyExclusive(p, "pr", "issue"),
    handler: stubs.createComment,
  },
  {
    name: "reply-to-thread",
    summary: "Post a reply in an existing PR review or ticket comment thread.",
    flags: [
      {
        name: "repo",
        kind: "string",
        required: true,
        description: "Repository in <owner>/<repo> form.",
      },
      {
        name: "thread-id",
        kind: "string",
        required: true,
        description: "Platform-stable thread identifier.",
      },
      {
        name: "body",
        kind: "string",
        required: true,
        description: "Reply body.",
      },
      {
        name: "agent-id",
        kind: "string",
        required: true,
        description: "Agent identifier placed in the machine marker.",
      },
    ],
    positionals: [],
    handler: stubs.replyToThread,
  },
  {
    name: "react",
    summary: "Add a reaction to a comment.",
    flags: [
      {
        name: "repo",
        kind: "string",
        required: true,
        description: "Repository in <owner>/<repo> form.",
      },
      {
        name: "comment-id",
        kind: "string",
        required: true,
        description: "Platform-stable comment identifier.",
      },
      {
        name: "reaction",
        kind: "string",
        required: true,
        choices: REACTIONS,
        description: "One of +1, -1, rocket, eyes.",
      },
    ],
    positionals: [],
    handler: stubs.react,
  },
  {
    name: "request-review",
    summary: "Request a review on a PR.",
    flags: [
      {
        name: "repo",
        kind: "string",
        required: true,
        description: "Repository in <owner>/<repo> form.",
      },
      {
        name: "pr",
        kind: "string",
        required: true,
        description: "PR number.",
      },
      {
        name: "reviewer",
        kind: "string[]",
        required: true,
        description: "Login to request (may be repeated).",
      },
    ],
    positionals: [],
    handler: stubs.requestReview,
  },
  {
    name: "pr-status",
    summary: "Emit the §2.2 XML document for a PR and update the disk cache.",
    flags: [
      {
        name: "repo",
        kind: "string",
        required: true,
        description: "Repository in <owner>/<repo> form.",
      },
      {
        name: "pr",
        kind: "string",
        required: true,
        description: "PR number.",
      },
      {
        name: "agent-id",
        kind: "string",
        required: true,
        description: "Calling agent's identity.",
      },
      {
        name: "skill",
        kind: "string",
        description: "Skill name used as the cache namespace.",
      },
    ],
    positionals: [],
    handler: stubs.prStatus,
  },
  {
    name: "ack-annotation",
    summary: "Mark an annotation as non-actionable (write the .ack marker).",
    flags: [
      {
        name: "repo",
        kind: "string",
        required: true,
        description: "Repository in <owner>/<repo> form.",
      },
      {
        name: "pr",
        kind: "string",
        required: true,
        description: "PR number.",
      },
      {
        name: "annotation-id",
        kind: "string",
        required: true,
        description: "Platform-stable annotation identifier.",
      },
      {
        name: "skill",
        kind: "string",
        description: "Skill name used as the cache namespace.",
      },
    ],
    positionals: [],
    handler: stubs.ackAnnotation,
  },
];

// Resolve a command by matching the longest leading-token prefix. The
// caller passes `argv` (already stripped of the dispatch binary name);
// the returned tuple is the matched command and the residual argv.
export function resolveCommand(
  argv: readonly string[],
): { command: CommandSpec; rest: readonly string[] } | null {
  // Try two-token names first (e.g. "daemon start") so they take
  // precedence over a hypothetical one-token "daemon".
  for (const c of commands) {
    const tokens = c.name.split(" ");
    if (tokens.length > argv.length) continue;
    let match = true;
    for (let i = 0; i < tokens.length; i++) {
      if (argv[i] !== tokens[i]) {
        match = false;
        break;
      }
    }
    if (match) return { command: c, rest: argv.slice(tokens.length) };
  }
  return null;
}
