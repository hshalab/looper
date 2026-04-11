import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger } from "../bootstrap/logger";
import { createDefaultLooperConfig } from "../config/index";
import { SqliteStore } from "../storage/sqlite/sqlite-store";
import { createLooperdRuntime } from "./index";

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
  const rootDir = await mkdtemp(join(tmpdir(), "looperd-runtime-"));
  cleanupPaths.push(rootDir);

  await Promise.all([
    mkdir(join(rootDir, "logs"), { recursive: true }),
    mkdir(join(rootDir, "workspace"), { recursive: true }),
  ]);

  const config = createDefaultLooperConfig(rootDir);
  config.server.host = "127.0.0.1";
  config.server.port = 0;
  config.storage.dbPath = join(rootDir, "state", "looper.sqlite");
  config.storage.backupDir = join(rootDir, "backups");
  config.daemon.logDir = join(rootDir, "logs");
  config.daemon.workingDirectory = join(rootDir, "workspace");

  const logger = await createLogger(config.logging, config.daemon.logDir);
  return { rootDir, config, logger };
}

describe("createLooperdRuntime", () => {
  test("runs recovery before serving API and marks interrupted work", async () => {
    const fixture = await createFixture();
    const seedStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
      backupDir: fixture.config.storage.backupDir,
    });
    seedStore.initialize({ autoMigrate: true });

    const now = "2026-04-11T12:00:00.000Z";
    seedStore.projects.upsert({
      id: "project_1",
      name: "Looper",
      repoPath: fixture.rootDir,
      baseBranch: "main",
      archived: false,
      metadataJson: null,
      createdAt: now,
      updatedAt: now,
    });
    seedStore.loops.upsert({
      id: "loop_1",
      projectId: "project_1",
      type: "reviewer",
      targetType: "pull_request",
      targetId: "pr:acme/looper:42",
      repo: "acme/looper",
      prNumber: 42,
      status: "running",
      configJson: null,
      metadataJson: null,
      lastRunAt: now,
      nextRunAt: null,
      createdAt: now,
      updatedAt: now,
    });
    seedStore.runs.upsert({
      id: "run_1",
      loopId: "loop_1",
      status: "running",
      currentStep: "review",
      lastCompletedStep: "snapshot",
      checkpointJson: null,
      summary: null,
      errorMessage: null,
      startedAt: now,
      lastHeartbeatAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    seedStore.locks.acquire({
      key: "pr:acme/looper:42",
      owner: "reviewer-loop",
      reason: "claim",
      expiresAt: "2020-01-01T00:00:00.000Z",
      createdAt: now,
      updatedAt: now,
    });
    seedStore.close();

    const runtime = createLooperdRuntime({
      config: fixture.config,
      logger: fixture.logger,
    });

    await runtime.start();

    const response = await fetch(
      `http://${fixture.config.server.host}:${fixture.config.server.port}/api/v1/status`,
    );
    const body = (await response.json()) as {
      ok: boolean;
      data: { service: { recovery: { interruptedRunsMarked: number } } };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.service.recovery.interruptedRunsMarked).toBe(1);

    const verifyStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
    });
    verifyStore.initialize();
    expect(verifyStore.runs.getById("run_1")?.status).toBe("interrupted");
    expect(verifyStore.loops.getById("loop_1")?.status).toBe("queued");
    expect(verifyStore.locks.get("pr:acme/looper:42")).toBeNull();
    expect(
      verifyStore.events
        .list()
        .some((event) => event.eventType === "looperd.started"),
    ).toBe(true);
    verifyStore.close();

    await runtime.stop("test");
  });
});
