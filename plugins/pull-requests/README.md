# pull-requests

Claude Code plugin for creating and monitoring pull requests.

## Scope

- Drafting PRs from a working branch
- Pushing, publishing, and updating PR metadata (title, body, labels, reviewers)
- Monitoring CI status and surfacing actionable failures
- Responding to review comments and iterating
- Merging, rebasing, and cleaning up branches

## Layout

```
pull-requests/
├── .claude-plugin/
│   └── plugin.json      # Plugin manifest
├── skills/              # Model-invoked skills (e.g. skills/open-pr/SKILL.md)
├── agents/              # Custom subagent definitions
├── commands/            # Optional flat-file slash commands
└── hooks/               # Event hooks (hooks.json)
```

Skills, agents, and hooks will be migrated in from elsewhere — this directory
currently contains only the scaffolding.

## Local development

```bash
claude --plugin-dir ./plugins/pull-requests
```
