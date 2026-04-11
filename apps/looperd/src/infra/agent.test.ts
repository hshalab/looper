import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteStore } from "../storage/sqlite/sqlite-store";
import { ConfiguredAgentExecutor, resolveAgentSpawn } from "./agent";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "looper-agent-"));
  cleanupPaths.push(rootDir);
  await mkdir(join(rootDir, "workspace"), { recursive: true });

  const store = new SqliteStore({
    dbPath: join(rootDir, "state", "looper.sqlite"),
  });
  store.initialize({ autoMigrate: true });

  return { rootDir, store, workspace: join(rootDir, "workspace") };
}

async function writeExecutable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

describe("ConfiguredAgentExecutor", () => {
  test("captures structured completion and persists execution", async () => {
    const fixture = await createFixture();
    const scriptPath = join(fixture.rootDir, "agent-success.sh");
    await writeExecutable(
      scriptPath,
      '#!/bin/sh\nprintf \'argv=%s|%s\\n\' "$1" "$2"\nprintf \'prompt=%s\\n\' "$LOOPER_PROMPT"\nprintf \'__LOOPER_RESULT__={"summary":"done","changedFiles":["src/index.ts"],"commits":["abc123"]}\\n\'\n',
    );

    const executor = new ConfiguredAgentExecutor({
      config: {
        vendor: "opencode",
        params: { command: scriptPath },
        env: {},
      },
      store: fixture.store,
    });

    const execution = await executor.start({
      executionId: "agent_exec_1",
      prompt: "implement feature",
      workingDirectory: fixture.workspace,
      timeoutMs: 5_000,
    });
    const result = await execution.wait();

    expect(result.status).toBe("completed");
    expect(result.parseStatus).toBe("parsed");
    expect(result.changedFiles).toEqual(["src/index.ts"]);
    expect(result.rawLogs.stdout).toContain("argv=run|implement feature");
    expect(fixture.store.agentExecutions.getById("agent_exec_1")?.status).toBe(
      "completed",
    );
    expect(
      fixture.store.events.listByEntity("agent_execution", "agent_exec_1")
        .length,
    ).toBe(2);

    fixture.store.close();
  });

  test("prepends opencode run when custom args omit it", async () => {
    const fixture = await createFixture();
    const scriptPath = join(fixture.rootDir, "agent-args.sh");
    await writeExecutable(
      scriptPath,
      '#!/bin/sh\nprintf \'argv=%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4"\nprintf \'__LOOPER_RESULT__={"summary":"done"}\\n\'\n',
    );

    const executor = new ConfiguredAgentExecutor({
      config: {
        vendor: "opencode",
        params: {
          command: scriptPath,
          args: ["--model", "gpt-5"],
        },
        env: {},
      },
      store: fixture.store,
    });

    const execution = await executor.start({
      prompt: "implement feature",
      workingDirectory: fixture.workspace,
      timeoutMs: 5_000,
    });
    const result = await execution.wait();

    expect(result.status).toBe("completed");
    expect(result.rawLogs.stdout).toContain(
      "argv=run|--model|gpt-5|implement feature",
    );

    fixture.store.close();
  });

  test("builds claude-code headless invocation", () => {
    expect(
      resolveAgentSpawn(
        {
          vendor: "claude-code",
          env: {},
        },
        "review this diff",
      ),
    ).toEqual({
      command: "claude",
      args: ["--print", "review this diff"],
    });
  });

  test("builds codex headless invocation", () => {
    expect(
      resolveAgentSpawn(
        {
          vendor: "codex",
          env: {},
        },
        "fix the failing test",
      ),
    ).toEqual({
      command: "codex",
      args: ["exec", "fix the failing test"],
    });
  });

  test("builds cursor headless invocation", () => {
    expect(
      resolveAgentSpawn(
        {
          vendor: "cursor-cli",
          env: {},
        },
        "implement the task",
      ),
    ).toEqual({
      command: "agent",
      args: ["--print", "implement the task"],
    });
  });

  test("injects model flags for vendor defaults", () => {
    expect(
      resolveAgentSpawn(
        {
          vendor: "codex",
          model: "gpt-5-codex",
          env: {},
        },
        "fix bug",
      ),
    ).toEqual({
      command: "codex",
      args: ["exec", "--model", "gpt-5-codex", "fix bug"],
    });
    expect(
      resolveAgentSpawn(
        {
          vendor: "opencode",
          model: "gpt-5",
          env: {},
        },
        "implement feature",
      ),
    ).toEqual({
      command: "opencode",
      args: ["run", "--model", "gpt-5", "implement feature"],
    });
  });

  test("times out long-running agent processes", async () => {
    const fixture = await createFixture();
    const scriptPath = join(fixture.rootDir, "agent-timeout.sh");
    await writeExecutable(scriptPath, "#!/bin/sh\nsleep 2\n");

    const executor = new ConfiguredAgentExecutor({
      config: {
        vendor: "opencode",
        params: { command: scriptPath },
        env: {},
      },
      store: fixture.store,
    });

    const execution = await executor.start({
      executionId: "agent_exec_timeout",
      prompt: "wait",
      workingDirectory: fixture.workspace,
      timeoutMs: 50,
      gracefulShutdownMs: 10,
    });
    const result = await execution.wait();

    expect(result.status).toBe("timeout");
    expect(
      fixture.store.agentExecutions.getById("agent_exec_timeout")?.status,
    ).toBe("timeout");

    fixture.store.close();
  });

  test("kills agent processes on explicit cancellation", async () => {
    const fixture = await createFixture();
    const scriptPath = join(fixture.rootDir, "agent-kill.sh");
    await writeExecutable(scriptPath, "#!/bin/sh\nsleep 2\n");

    const executor = new ConfiguredAgentExecutor({
      config: {
        vendor: "opencode",
        params: { command: scriptPath },
        env: {},
      },
      store: fixture.store,
    });

    const execution = await executor.start({
      executionId: "agent_exec_kill",
      prompt: "wait",
      workingDirectory: fixture.workspace,
      timeoutMs: 5_000,
      gracefulShutdownMs: 10,
    });
    await execution.kill("cancelled by test");
    const result = await execution.wait();

    expect(result.status).toBe("killed");
    expect(
      fixture.store.agentExecutions.getById("agent_exec_kill")?.status,
    ).toBe("killed");
    expect(
      fixture.store.events
        .listByEntity("agent_execution", "agent_exec_kill")
        .some((event) => event.eventType === "agent.killed"),
    ).toBe(true);

    fixture.store.close();
  });
});
