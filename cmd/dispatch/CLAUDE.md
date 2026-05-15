# CLAUDE.md — cmd/dispatch

Guidance for Claude Code when working in the `dispatch` CLI.

## TypeScript conventions

- **`.mts` only.** Every TypeScript source file uses the `.mts`
  extension. Do not add `.ts` files. There is no transpile step for
  source — files run as-is.
- **Explicit `.mts` import specifiers.** Relative imports MUST carry the
  `.mts` extension (e.g. `import { x } from "./foo.mts"`), per Node's
  ESM resolution and `tsconfig` `allowImportingTsExtensions`.
- **Node native TypeScript.** Run and develop via Node's built-in type
  stripping (`node src/index.mts`). Do NOT add `tsx`, `ts-node`, or any
  other TypeScript runtime loader to the toolchain.
- **Erasable syntax only.** Type stripping requires erasable syntax —
  no `enum`, no `namespace`, no constructor parameter properties, no
  `experimentalDecorators`. This is enforced by `erasableSyntaxOnly` in
  `tsconfig.json`; keep it on.
- **Typecheck** with `tsc --noEmit` (`npm run typecheck`). `tsc` is for
  checking only; it never emits.

## Layout

| Path             | Contents                                          |
| ---------------- | ------------------------------------------------- |
| `src/index.mts`  | CLI entry point and subcommand router             |
| `src/commands/`  | One module per CLI subcommand                      |
| `src/daemon/`    | Daemon process: state dir, PID lock, log, run loop |
| `src/cli/`       | Argument parsing helpers                           |
| `src/util/`      | Shared utilities (errors, etc.)                    |

See `docs/spec/03-cli/` for the normative CLI and daemon specification.
