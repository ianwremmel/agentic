# model

Pure domain types and vocabulary. No SQL.

- `status.mts` — the tracker-neutral enums (`Status`, `TargetKind`, `PrOrigin`,
  `Kind`, `OutcomeKind`), their guards, `GROUP_OF`, and `RESOLVED_STATUSES`.
- `types.mts` — the domain model interfaces (`Project`, `Ticket`, `Pr`, …) the
  stores map rows to and from.
