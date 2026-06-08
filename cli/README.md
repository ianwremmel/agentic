# dispatch CLI

The Rust implementation of the `dispatch` command. Today it exposes a single
subcommand, `pr-status` (the §2.2 PR Status Protocol producer), ported from the
original `plugins/dispatch/skills/deliver/scripts/pr-status` bash script. The
command tree is structured to grow into the rest of §3.2 — daemon, prompt,
task, and the other interaction commands — and, in time, a background daemon
and an MCP server.

## How it ships

Claude Code plugins are copied into a cache at install with no build step, so
the binary must already exist for the user's platform. We therefore **commit
pre-built binaries** under the plugin:

```
plugins/dispatch/bin/
  dispatch                              # platform-selecting launcher (bash)
  <rust-target-triple>/dispatch         # committed binary for that platform
  <rust-target-triple>/SOURCE_HASH      # source hash the binary was built from
```

The launcher (`bin/dispatch`) maps the host OS/arch to a target triple and
execs the matching binary. When no binary is committed for the host yet, it
falls back to `skills/deliver/scripts/pr-status.legacy.bash` so the plugin keeps
working on every platform while binaries roll out.

The skill still calls `skills/deliver/scripts/pr-status`; that path is now a
thin shim that delegates to the launcher.

## Targets

| Target triple                | Platform              |
| ---------------------------- | --------------------- |
| `x86_64-unknown-linux-gnu`   | Linux x86-64          |
| `aarch64-unknown-linux-gnu`  | Linux ARM64           |
| `x86_64-apple-darwin`        | macOS Intel           |
| `aarch64-apple-darwin`       | macOS Apple Silicon   |

## Building and committing binaries

CI builds and tests every target on each push (`.github/workflows/cli.yml`), but
**never commits** — staging the per-platform binaries is a developer step.

All four targets cross-compile from a single host (Linux or macOS). The Apple
targets are linked with [`cargo-zigbuild`](https://github.com/rust-cross/cargo-zigbuild),
which uses `zig` as the linker and bundles the macOS libc stubs, so no Apple SDK
is required; the Linux ARM64 target uses the GNU cross-linker.

### One-time toolchain setup

```sh
rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu \
                  x86_64-apple-darwin aarch64-apple-darwin

# Apple targets (Mach-O linker, via zig):
pip3 install ziglang            # bundles the zig compiler; cargo-zigbuild finds it
cargo install cargo-zigbuild

# Linux ARM64 target (cross-linker), on a Debian/Ubuntu host:
sudo apt-get install -y gcc-aarch64-linux-gnu
```

The aarch64-linux linker is wired up in `cli/.cargo/config.toml`; the build
script invokes `cargo zigbuild` for `*-apple-darwin` automatically.

### Build + stage

```sh
# Build every target this host can produce and stage them under the plugin.
cli/scripts/build-binaries.sh

# Or a subset:
TARGETS="x86_64-apple-darwin aarch64-apple-darwin" cli/scripts/build-binaries.sh
```

`build-binaries.sh` skips any target whose toolchain is missing (with a
warning) rather than failing the whole run. Commit whatever it stages under
`plugins/dispatch/bin/`.

### Freshness

Each committed binary carries a `SOURCE_HASH` (a deterministic hash of the CLI
source, from `cli/scripts/source-hash.sh`). CI's `verify-committed` job fails if
any committed binary's hash doesn't match the current source — that's the signal
to rebuild and re-commit. CI does not compare binary bytes (Rust builds aren't
byte-reproducible across machines); the source hash is the contract.

## Development

```sh
cd cli
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt
```

The `pr-status` command shells out to `gh`, `git`, and `claude` exactly as the
bash did; only the text munging that bash delegated to `jq`/`sha256sum`/`sed`/
`tr`/`grep` is native Rust.
