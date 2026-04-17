# linear

Claude Code plugin for orchestrating projects via [Linear.app](https://linear.app).

## Scope

- Triaging incoming issues
- Planning and breaking down projects into actionable Linear issues
- Status updates, standups, and cross-team sync
- Keeping Linear issues and GitHub PRs in sync

## Layout

```
linear/
├── .claude-plugin/
│   └── plugin.json      # Plugin manifest
├── skills/              # Model-invoked skills (e.g. skills/triage/SKILL.md)
├── agents/              # Custom subagent definitions
├── commands/            # Optional flat-file slash commands
└── hooks/               # Event hooks (hooks.json)
```

Skills, agents, and hooks will be migrated in from elsewhere — this directory
currently contains only the scaffolding.

## Local development

```bash
claude --plugin-dir ./plugins/linear
```
