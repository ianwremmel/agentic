// Stub handlers for every subcommand declared in the spec. Real
// implementations land in their own issues (#23+); for now each stub
// throws DispatchError so the router can exercise routing and exit
// codes end-to-end.

import { DispatchError, ExitCode } from "./errors.mts";
import { daemonStart } from "./daemon-start.mts";
import { daemonStatus } from "./daemon-status.mts";
import { daemonStop } from "./daemon-stop.mts";
import type { CommandHandler } from "./types.mts";

function notImplemented(name: string): CommandHandler {
  return () => {
    throw new DispatchError(
      ExitCode.GENERIC,
      `command not yet implemented; tracked separately`,
      name,
    );
  };
}

export const stubs = {
  daemonStart,
  daemonStop,
  daemonStatus,

  promptsList: notImplemented("prompts list"),
  promptsCopy: notImplemented("prompts copy"),
  promptsDiff: notImplemented("prompts diff"),

  tasksList: notImplemented("tasks list"),
  tasksRemove: notImplemented("tasks remove"),
  tasksShow: notImplemented("tasks show"),

  addTicket: notImplemented("add-ticket"),
  addProject: notImplemented("add-project"),
  addPr: notImplemented("add-pr"),

  createComment: notImplemented("create-comment"),
  replyToThread: notImplemented("reply-to-thread"),
  react: notImplemented("react"),
  requestReview: notImplemented("request-review"),
  prStatus: notImplemented("pr-status"),
  ackAnnotation: notImplemented("ack-annotation"),
} as const;
