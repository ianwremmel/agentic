# liveness

Process-level liveness for session registry rows — the half heartbeat
freshness cannot see. Servers record their own process start as
`started_at`; the probe (`ps -o etime=`) reads the running process's start
back and `sameProcess` compares the two, so a reused pid never resolves.

The two consumers lean opposite ways. `withLiveProcesses` (matching) needs
proof of life: anything unverifiable — another host, no pid, a failed probe
— is dropped, because a false `active` strands a session while a false
`inactive` only costs polling. `retireNonLive` (the server's startup sweep)
needs proof of death: it deletes a row only for a stale heartbeat, a
vanished pid, or a reused pid, and leaves what it merely cannot verify to
the heartbeat sweep.
