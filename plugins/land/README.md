# land

> Claude Code plugin for bringing one pull request to completion.

One skill, `deliver`, drives a single change from nothing to merged: open a
draft PR, write the code, triage CI, answer every reviewer, and keep polling
until the PR closes. There is no database and no ledger — every decision is
re-derived from the PR itself on each tick. The only thing on disk is the
`pr-status` cache described below.

Start it from any of three inputs:

```text
/land:deliver https://github.com/owner/repo/pull/42   # an existing PR
/land:deliver https://linear.app/acme/issue/DEV-123   # a ticket
/land:deliver make the retry backoff configurable     # a prompt
```

A ticket-backed run also claims the ticket and syncs its state
(`in-progress` → `in-review` → `delivered`) as the PR moves.

## Install

From inside Claude Code, after adding the `agentic` marketplace:

```shell
/plugin install land@agentic
```

See the [root README](/README.md#install) for marketplace setup.

`operator_login` — the GitHub login of the human directing the agent — is
required; the skill and `pr-status` both refuse to run without it. The other
options (`operator_mode`, `credential_mode`, `copilot_available`,
`worktree_base`, `tracker`) have defaults.

The `dispatch` plugin ships its own copy of this skill and its own `pr-status`.
Installing both puts two `pr-status` scripts on `PATH` and splits the operator
config across two plugin keys — install one or the other.

## pr-status

`bin/pr-status` is the skill's only view of a PR. It emits one XML snapshot per
call and caches every comment, thread, and annotation body under
`$XDG_CACHE_HOME/land/deliver/<owner>__<repo>/<pr>/`:

```shell
pr-status 42
```

```xml
<pr-status repo="owner/repo" pr="42" head="feat/backoff">
  <terminal state="open" gh-merged="false" ahead-by="-"/>
  <checks state="passing">…</checks>
  <merge-conflicts present="false"/>
  <reviews>…</reviews>
  <comments>…</comments>
  <threads>…</threads>
  <annotations>…</annotations>
</pr-status>
```

Each comment, thread, and annotation carries `actionable="true|false"` — the
skill's sole task source — plus a `reason=` when suppressed and a `cache=` path
to the full text. Top-level comments are fully paginated; review threads are
capped at the first 100. `<terminal>` answers *did the change ship*, surviving squash
and rebase merges by comparing content rather than commits.

Requires `gh` and `jq` on `PATH`, and must run inside the repo's git worktree.
`git` and `claude` are optional: without them, terminal resolution and comment
summaries degrade rather than fail. Environment overrides:

| Variable                    | Effect                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| `LAND_CACHE_DIR`            | Cache root (default `$XDG_CACHE_HOME/land`).                       |
| `LAND_INFORMATIONAL_CHECKS` | Regex of check names that never fail the rollup.                   |
| `LAND_STUCK_AFTER_SEC`      | Seconds before an in-progress check reads as stuck (default 3600). |

## Trackers

Linear bindings ship inside the skill
([`skills/deliver/ticket.md`](skills/deliver/ticket.md)). Any other tracker is
driven best-effort through its own MCP server, mapping native states onto the
skill's roles at run time. For multi-ticket project orchestration and pluggable
tracker adapters, use the [`dispatch`](../dispatch) plugin instead.

## Contributing

See the [root README](/README.md#contributing) for branch and commit
conventions.

## License

[MIT](/LICENSE) © Ian Remmel
