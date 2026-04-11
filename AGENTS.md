# AGENTS.md

## Commands
- Use Bun for everything. Root scripts are the source of truth:
  - `bun run dev` -> runs only `apps/looperd`
  - `bun run build` -> builds `apps/looperd`, then `apps/cli`, then `apps/web`
  - `bun run typecheck` -> `bun x tsc -b --noEmit` across all three apps
  - `bun run lint` -> `bun x @biomejs/biome check .`
  - `bun run test` -> `bun test`
- Package-scoped commands:
  - `bun run --cwd apps/looperd dev|build|typecheck`
  - `bun run --cwd apps/cli dev|build|typecheck|test`
  - `bun run --cwd apps/web dev|build|typecheck`
- Focused tests: run Bun against the file you changed, e.g. `bun test apps/looperd/src/config/load.test.ts` or `bun test tests/smoke.test.ts`.

## Repo shape
- Bun workspace monorepo: `apps/*`.
- `apps/looperd` is the real product. Entry flow is `src/index.ts` -> `bootstrapLooperd()` -> runtime -> Bun HTTP API server + SQLite store.
- `apps/cli` is the `looper` bin. It talks to looperd over HTTP and reuses the same config loading pattern.
- `apps/web` is currently a placeholder (`src/index.ts` only logs a message). Do not assume there is a real web app yet.

## Config and runtime gotchas
- Default daemon config path is `~/.looper/config.json`.
- Config precedence is: defaults -> config file -> env -> CLI flags.
- looperd fails fast on config validation errors and requires writable runtime paths.
- Tool paths for `bun`, `git`, `gh`, and `osascript` are auto-detected with `Bun.which()` unless explicitly configured.
- If `notifications.osascript.enabled` is true, `osascript` must resolve or startup fails.
- Default runtime artifacts live under `~/.looper/` (`looper.sqlite`, `backups/`, `logs/`).

## Verified agent-facing conventions
- TypeScript uses project references from the root `tsconfig.json`; prefer root `bun run typecheck` when changes cross packages, and it is intentionally `--noEmit` to avoid regenerating `*.tsbuildinfo`.
- Formatting/linting is Biome with spaces; use Biome-compatible edits and do not hand-format against another style.
- Generated/build output lives in `apps/*/dist/` and is ignored by git/Biome; do not edit `dist`.
- CI lives in `.github/workflows/ci.yml` and runs on PR updates: `bun install --frozen-lockfile`, then `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build`.
