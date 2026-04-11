# AGENTS.md

## Rules

- After every code change, run `biome format` on each modified file supported by Biome before finishing.

## Commands

- Use Bun for everything. Root scripts are the source of truth:
  - `bun run dev` — runs `apps/looperd` only.
  - `bun run build` — builds `apps/looperd`, then `apps/cli`, then `apps/web`.
  - `bun run typecheck` — runs `bun x tsc -b --noEmit` across all three apps.
  - `bun run lint` — runs `bun x @biomejs/biome check .`.
  - `bun run test` — runs `bun test`.
- Package-scoped commands:
  - `bun run --cwd apps/looperd dev|build|typecheck`
  - `bun run --cwd apps/cli dev|build|typecheck|test`
  - `bun run --cwd apps/web dev|build|typecheck`
- Focused tests: run Bun against the changed file directly, e.g. `bun test apps/looperd/src/config/load.test.ts` or `bun test tests/smoke.test.ts`.

## Repo structure

- Bun workspace monorepo rooted at `apps/*`.
- `apps/looperd` — primary application. Entry: `src/index.ts` → `bootstrapLooperd()` → runtime → Bun HTTP API server + SQLite store.
- `apps/cli` — the `looper` binary. Communicates with looperd over HTTP; reuses the same config-loading pattern.
- `apps/web` — placeholder only (`src/index.ts` logs a message). No functional web app exists.

## Configuration & runtime

- Default daemon config path: `~/.looper/config.json`.
- Precedence: defaults → config file → env → CLI flags.
- looperd fails fast on config-validation errors and requires writable runtime paths.
- Tool paths (`bun`, `git`, `gh`, `osascript`) are auto-detected via `Bun.which()` unless explicitly configured.
- When `notifications.osascript.enabled` is true, `osascript` must resolve or startup fails.
- Default runtime artifacts: `~/.looper/` (`looper.sqlite`, `backups/`, `logs/`).

## Conventions

- TypeScript uses project references from the root `tsconfig.json`. Prefer `bun run typecheck` at the root when changes cross packages. The `--noEmit` flag is intentional — do not regenerate `*.tsbuildinfo`.
- Formatting and linting use Biome (spaces). Make Biome-compatible edits only; do not hand-format to another style.
- Build output lives in `apps/*/dist/` and is git/Biome-ignored. Do not edit `dist`.
- CI (`.github/workflows/ci.yml`) runs on PR updates: `bun install --frozen-lockfile` → `bun run lint` → `bun run typecheck` → `bun run test` → `bun run build`.

## Review guidelines

- Report every issue found. Do not prioritize, triage, or omit.
- Continue reviewing after finding issues. Early termination is a defect.
- Review systematically across correctness, performance, maintainability, and style.
