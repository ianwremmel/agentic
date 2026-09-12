# graph

The derived read-model: every scheduling decision, as SQL over the stores'
tables. Consumers read results; nothing re-derives.

- `pipeline.mts` — the shared CTE prefix (edge semantics, blocking closure,
  claim liveness, milestone gating, classification, the dispatch queue) plus
  the rank/queue orderings and parameter plumbing. Read its doc comment first.
- `queries.mts` — `classifiedItems`, `frontier`, `dispatchQueue`,
  `milestoneStates` over the prefix, plus `repoPrLoad`: per-repo open and
  building PR counts for the admission caps, read from the stored watch
  snapshots rather than a fetch of its own.
- `anomalies.mts` — global structure writes could not refuse: dangling
  placeholder endpoints, mutually blocking projects, cycles as a safety net.
- `derive.mts` — assembles counts and the terminal verdict from the above.
- `rows.mts` — row → model narrowing shared by the queries.
- `types.mts` — the result types and `DeriveOptions`.
