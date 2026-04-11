import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger } from "../bootstrap/logger";
import { createDefaultLooperConfig } from "../config/index";
import type { AgentResult, AgentRunInput } from "../infra/agent";
import { SchedulerQueue } from "../scheduler/index";
import { SqliteStore } from "../storage/sqlite/sqlite-store";
import type {
  PullRequestSnapshotRecord,
  WorktreeRecord,
} from "../storage/types";
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

class FakeGitHubGateway {
  public submitCalls: Array<{ repo: string; prNumber: number; event: string }> =
    [];
  public createPullRequestCalls = 0;
  public resolvedThreadIds: string[] = [];
  private fixerViewIndex = 0;

  public async listOpenPullRequests() {
    return [
      {
        number: 42,
        title: "Review and fix me",
        state: "OPEN",
        isDraft: false,
        reviewDecision: "CHANGES_REQUESTED",
        author: "octocat",
        reviewRequests: ["octocat"],
      },
    ];
  }

  public async viewPullRequest() {
    const fixerResponses = [
      {
        comments: [{ id: "c1", state: "UNRESOLVED", body: "needs fix" }],
        checks: [],
      },
      {
        comments: [{ id: "c1", state: "UNRESOLVED", body: "needs fix" }],
        checks: [],
      },
      {
        comments: [],
        checks: [],
      },
    ];
    const response = fixerResponses[this.fixerViewIndex] ??
      fixerResponses[fixerResponses.length - 1] ?? {
        comments: [],
        checks: [],
      };
    this.fixerViewIndex += 1;

    return {
      number: 42,
      title: "Review and fix me",
      body: "body",
      url: "https://example.test/pr/42",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "CHANGES_REQUESTED",
      headRefName: "feature/runtime",
      baseRefName: "main",
      headSha: "abc123",
      baseSha: "base123",
      author: "octocat",
      reviewRequests: ["octocat"],
      comments: response.comments,
      reviews: [],
      checks: response.checks,
    };
  }

  public async getCurrentUserLogin(): Promise<string> {
    return "octocat";
  }

  public async capturePullRequestSnapshot(input: {
    projectId: string;
    repo: string;
    prNumber: number;
    capturedAt?: string;
  }): Promise<PullRequestSnapshotRecord> {
    return {
      id: `snapshot:${input.prNumber}:${input.capturedAt}`,
      projectId: input.projectId,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: "abc123",
      baseSha: "base123",
      title: "Review and fix me",
      body: "body",
      author: "octocat",
      diffRef: "gh:diff",
      checksSummary: "SUCCESS",
      unresolvedThreadCount: 1,
      reviewState: "CHANGES_REQUESTED",
      payloadJson: JSON.stringify({ diff: "diff --git a/a.ts b/a.ts" }),
      capturedAt: input.capturedAt ?? "2026-04-11T12:00:00.000Z",
      createdAt: input.capturedAt ?? "2026-04-11T12:00:00.000Z",
    };
  }

  public async submitReview(input: {
    repo: string;
    prNumber: number;
    event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  }): Promise<void> {
    this.submitCalls.push(input);
  }

  public async createPullRequest(): Promise<{ number?: number; url: string }> {
    this.createPullRequestCalls += 1;
    return {
      number: 101,
      url: "https://example.test/pr/101",
    };
  }

  public async resolveReviewThread(input: {
    repo: string;
    threadId: string;
    cwd?: string;
  }): Promise<void> {
    this.resolvedThreadIds.push(input.threadId);
  }
}

class FakeGitGateway {
  public pushCalls = 0;
  public createWorktreeCalls = 0;
  public commitCalls = 0;
  public cleanupCalls = 0;

  public async detectGitHubRepo(): Promise<string | null> {
    return "powerformer/looper";
  }

  public async push(): Promise<void> {
    this.pushCalls += 1;
  }

  public async prepareWorktree(): Promise<{
    headSha?: string;
    clean: boolean;
  }> {
    return { headSha: "abc123", clean: true };
  }

  public async inspectHead(): Promise<{
    headSha?: string;
    newCommitShas: string[];
    hasUncommittedChanges: boolean;
    changedFiles: string[];
  }> {
    return {
      headSha: "commit-1",
      newCommitShas: ["commit-1"],
      hasUncommittedChanges: false,
      changedFiles: [],
    };
  }

  public async commit(): Promise<{ commitSha: string }> {
    this.commitCalls += 1;
    return { commitSha: "commit-1" };
  }

  public async cleanupWorktree(): Promise<void> {
    this.cleanupCalls += 1;
  }

  public async createWorktree(input: {
    projectId: string;
    taskId?: string;
    repoPath: string;
    worktreeRoot: string;
    branch: string;
    baseBranch: string;
    protectedBranches?: string[];
  }): Promise<WorktreeRecord> {
    this.createWorktreeCalls += 1;
    return {
      id: `worktree:${input.branch}`,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      repoPath: input.repoPath,
      worktreePath: input.worktreeRoot,
      branch: input.branch,
      baseBranch: input.baseBranch,
      status: "active",
      headSha: "abc123",
      metadataJson: null,
      createdAt: "2026-04-11T12:00:00.000Z",
      updatedAt: "2026-04-11T12:00:00.000Z",
      cleanedAt: null,
    };
  }
}

class FakeAgentExecutor {
  public starts: AgentRunInput[] = [];

  constructor(private readonly results: AgentResult[]) {}

  public async start(input: AgentRunInput) {
    this.starts.push(input);
    const result = this.results.shift();
    if (!result) {
      throw new Error("No agent result queued");
    }

    return {
      wait: async () => result,
    };
  }
}

function completedAgentResult(summary: string): AgentResult {
  return {
    status: "completed",
    summary,
    artifacts: [],
    changedFiles: [],
    commits: [],
    rawLogs: { stdout: `${summary}\n`, stderr: "" },
    parseStatus: "parsed",
    completionSignal: "done",
    heartbeatCount: 1,
    resourceUsage: {
      wallTimeMs: 10,
      outputBytes: summary.length,
    },
    pid: 1234,
  };
}

function failedAgentResult(summary: string): AgentResult {
  return {
    status: "failed",
    summary,
    artifacts: [],
    changedFiles: [],
    commits: [],
    rawLogs: { stdout: "", stderr: `${summary}\n` },
    parseStatus: "parsed",
    completionSignal: "done",
    heartbeatCount: 1,
    resourceUsage: {
      wallTimeMs: 10,
      outputBytes: summary.length,
    },
    pid: 1234,
  };
}

describe("createLooperdRuntime", () => {
  test("runs recovery before serving API and marks interrupted work", async () => {
    const fixture = await createFixture();
    const seedStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
      backupDir: fixture.config.storage.backupDir,
    });
    seedStore.initialize({ autoMigrate: true });

    const now = new Date(Date.now() - 1_000).toISOString();
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

  test("auto-discovers and processes reviewer work on startup", async () => {
    const fixture = await createFixture();
    fixture.config.agent.vendor = "opencode";
    fixture.config.defaults.allowAutoCommit = true;
    const now = new Date(Date.now() - 1_000).toISOString();
    const seedStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
      backupDir: fixture.config.storage.backupDir,
    });
    seedStore.initialize({ autoMigrate: true });
    seedStore.projects.upsert({
      id: "project_1",
      name: "Looper",
      repoPath: fixture.rootDir,
      baseBranch: "main",
      archived: false,
      metadataJson: JSON.stringify({ repo: "powerformer/looper" }),
      createdAt: now,
      updatedAt: now,
    });
    seedStore.close();

    const github = new FakeGitHubGateway();
    const agentExecutor = new FakeAgentExecutor([
      completedAgentResult("Looks good overall"),
    ]);

    const runtime = createLooperdRuntime({
      config: fixture.config,
      logger: fixture.logger,
      github,
      agentExecutor,
      enableFixer: false,
    });

    await runtime.start();

    const verifyStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
    });
    verifyStore.initialize();

    expect(
      verifyStore.loops.list().some((loop) => loop.type === "reviewer"),
    ).toBe(true);
    expect(agentExecutor.starts).toHaveLength(1);
    expect(github.submitCalls.length).toBeGreaterThan(0);
    verifyStore.close();

    await runtime.stop("test");
  });

  test("sends failure notification for failed reviewer run", async () => {
    const fixture = await createFixture();
    fixture.config.agent.vendor = "opencode";
    fixture.config.defaults.allowAutoCommit = true;
    const now = "2026-04-11T12:00:00.000Z";
    const seedStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
      backupDir: fixture.config.storage.backupDir,
    });
    seedStore.initialize({ autoMigrate: true });
    seedStore.projects.upsert({
      id: "project_1",
      name: "Looper",
      repoPath: fixture.rootDir,
      baseBranch: "main",
      archived: false,
      metadataJson: JSON.stringify({ repo: "powerformer/looper" }),
      createdAt: now,
      updatedAt: now,
    });
    seedStore.close();

    const github = new FakeGitHubGateway();
    const agentExecutor = new FakeAgentExecutor([
      failedAgentResult("agent crashed while reviewing"),
    ]);

    const runtime = createLooperdRuntime({
      config: fixture.config,
      logger: fixture.logger,
      github,
      agentExecutor,
      enableFixer: false,
    });

    await runtime.start();
    await Bun.sleep(50);

    const verifyStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
    });
    verifyStore.initialize();

    const failureNotifications = verifyStore.notifications
      .list()
      .filter(
        (record) =>
          record.channel === "in_app" &&
          record.level === "failure" &&
          record.entityType === "run",
      );
    expect(failureNotifications.length).toBeGreaterThan(0);
    expect(failureNotifications[0]?.body).toContain(
      "agent crashed while reviewing",
    );

    verifyStore.close();
    await runtime.stop("test");
  });

  test("auto-discovers and processes fixer work on startup", async () => {
    const fixture = await createFixture();
    fixture.config.agent.vendor = "opencode";
    const now = "2026-04-11T12:00:00.000Z";
    const seedStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
      backupDir: fixture.config.storage.backupDir,
    });
    seedStore.initialize({ autoMigrate: true });
    seedStore.projects.upsert({
      id: "project_1",
      name: "Looper",
      repoPath: fixture.rootDir,
      baseBranch: "main",
      archived: false,
      metadataJson: JSON.stringify({ repo: "powerformer/looper" }),
      createdAt: now,
      updatedAt: now,
    });
    seedStore.close();

    const github = new FakeGitHubGateway();
    const git = new FakeGitGateway();
    const agentExecutor = new FakeAgentExecutor([
      completedAgentResult("fixed"),
    ]);

    const runtime = createLooperdRuntime({
      config: fixture.config,
      logger: fixture.logger,
      github,
      git,
      agentExecutor,
      enableReviewer: false,
    });

    await runtime.start();

    const verifyStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
    });
    verifyStore.initialize();

    expect(verifyStore.loops.list().some((loop) => loop.type === "fixer")).toBe(
      true,
    );
    expect(agentExecutor.starts).toHaveLength(1);
    expect(git.pushCalls).toBe(1);
    verifyStore.close();

    await runtime.stop("test");
  });

  test("boots without coding agent and skips reviewer/fixer runners", async () => {
    const fixture = await createFixture();
    const now = "2026-04-11T12:00:00.000Z";
    const seedStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
      backupDir: fixture.config.storage.backupDir,
    });
    seedStore.initialize({ autoMigrate: true });
    seedStore.projects.upsert({
      id: "project_1",
      name: "Looper",
      repoPath: fixture.rootDir,
      baseBranch: "main",
      archived: false,
      metadataJson: JSON.stringify({ repo: "powerformer/looper" }),
      createdAt: now,
      updatedAt: now,
    });
    seedStore.close();

    const github = new FakeGitHubGateway();
    const git = new FakeGitGateway();

    const runtime = createLooperdRuntime({
      config: fixture.config,
      logger: fixture.logger,
      github,
      git,
    });

    await runtime.start();

    const verifyStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
    });
    verifyStore.initialize();

    expect(
      verifyStore.loops.list().some((loop) => loop.type === "reviewer"),
    ).toBe(false);
    expect(verifyStore.loops.list().some((loop) => loop.type === "fixer")).toBe(
      false,
    );
    verifyStore.close();

    await runtime.stop("test");
  });

  test("processes scheduled worker queue items", async () => {
    const fixture = await createFixture();
    fixture.config.agent.vendor = "opencode";
    const now = new Date(Date.now() - 1_000).toISOString();
    const seedStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
      backupDir: fixture.config.storage.backupDir,
    });
    seedStore.initialize({ autoMigrate: true });
    seedStore.projects.upsert({
      id: "project_1",
      name: "Looper",
      repoPath: fixture.rootDir,
      baseBranch: "main",
      archived: false,
      metadataJson: JSON.stringify({ repo: "powerformer/looper" }),
      createdAt: now,
      updatedAt: now,
    });
    seedStore.loops.upsert({
      id: "loop_worker_1",
      projectId: "project_1",
      type: "worker",
      targetType: "task",
      targetId: "task:task_1",
      repo: "powerformer/looper",
      prNumber: null,
      status: "queued",
      configJson: null,
      metadataJson: null,
      lastRunAt: null,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    });
    seedStore.tasks.upsert({
      id: "task_1",
      projectId: "project_1",
      title: "Implement worker loop",
      description: "Ship worker loop behavior",
      status: "in_progress",
      loopId: "loop_worker_1",
      repo: "powerformer/looper",
      prNumber: null,
      metadataJson: JSON.stringify({ specPath: "spec.md" }),
      createdAt: now,
      updatedAt: now,
    });
    seedStore.taskItems.upsert({
      id: "item_1",
      taskId: "task_1",
      content: "Do the thing",
      status: "pending",
      position: 0,
      source: "spec",
      metadataJson: null,
      createdAt: now,
      updatedAt: now,
    });
    const scheduler = new SchedulerQueue({
      store: seedStore,
      retryMaxAttempts: 3,
      retryBaseDelayMs: 0,
    });
    scheduler.enqueue({
      id: "queue_worker_1",
      projectId: "project_1",
      loopId: "loop_worker_1",
      taskId: "task_1",
      type: "worker",
      targetType: "task",
      targetId: "task:task_1",
      repo: "powerformer/looper",
      dedupeKey: "worker:task_1",
      availableAt: now,
    });
    await writeFile(join(fixture.rootDir, "spec.md"), "# Worker spec\n");
    seedStore.close();

    const github = new FakeGitHubGateway();
    const git = new FakeGitGateway();
    const agentExecutor = new FakeAgentExecutor([completedAgentResult("done")]);

    const runtime = createLooperdRuntime({
      config: fixture.config,
      logger: fixture.logger,
      github,
      git,
      agentExecutor,
      enableReviewer: false,
      enableFixer: false,
    });

    await runtime.start();
    await Bun.sleep(50);

    expect(agentExecutor.starts).toHaveLength(1);
    expect(git.createWorktreeCalls).toBe(1);
    await runtime.stop("test");
  });

  test("sends failure notification for failed worker run", async () => {
    const fixture = await createFixture();
    fixture.config.agent.vendor = "opencode";
    const now = new Date(Date.now() - 1_000).toISOString();
    const seedStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
      backupDir: fixture.config.storage.backupDir,
    });
    seedStore.initialize({ autoMigrate: true });
    seedStore.projects.upsert({
      id: "project_1",
      name: "Looper",
      repoPath: fixture.rootDir,
      baseBranch: "main",
      archived: false,
      metadataJson: JSON.stringify({ repo: "powerformer/looper" }),
      createdAt: now,
      updatedAt: now,
    });
    seedStore.loops.upsert({
      id: "loop_worker_1",
      projectId: "project_1",
      type: "worker",
      targetType: "task",
      targetId: "task:task_1",
      repo: "powerformer/looper",
      prNumber: null,
      status: "queued",
      configJson: null,
      metadataJson: null,
      lastRunAt: null,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    });
    seedStore.tasks.upsert({
      id: "task_1",
      projectId: "project_1",
      title: "Implement worker loop",
      description: "Ship worker loop behavior",
      status: "in_progress",
      loopId: "loop_worker_1",
      repo: "powerformer/looper",
      prNumber: null,
      metadataJson: JSON.stringify({ specPath: "spec.md" }),
      createdAt: now,
      updatedAt: now,
    });
    seedStore.taskItems.upsert({
      id: "item_1",
      taskId: "task_1",
      content: "Do the thing",
      status: "pending",
      position: 0,
      source: "spec",
      metadataJson: null,
      createdAt: now,
      updatedAt: now,
    });
    const scheduler = new SchedulerQueue({
      store: seedStore,
      retryMaxAttempts: 3,
      retryBaseDelayMs: 0,
    });
    scheduler.enqueue({
      id: "queue_worker_1",
      projectId: "project_1",
      loopId: "loop_worker_1",
      taskId: "task_1",
      type: "worker",
      targetType: "task",
      targetId: "task:task_1",
      repo: "powerformer/looper",
      dedupeKey: "worker:task_1",
      availableAt: now,
    });
    await writeFile(join(fixture.rootDir, "spec.md"), "# Worker spec\n");
    seedStore.close();

    const github = new FakeGitHubGateway();
    const git = new FakeGitGateway();
    const agentExecutor = new FakeAgentExecutor([
      failedAgentResult("worker agent crashed"),
    ]);

    const runtime = createLooperdRuntime({
      config: fixture.config,
      logger: fixture.logger,
      github,
      git,
      agentExecutor,
      enableReviewer: false,
      enableFixer: false,
    });

    await runtime.start();
    await Bun.sleep(50);

    const verifyStore = new SqliteStore({
      dbPath: fixture.config.storage.dbPath,
    });
    verifyStore.initialize();
    const failureNotifications = verifyStore.notifications
      .list()
      .filter(
        (record) =>
          record.channel === "in_app" &&
          record.level === "failure" &&
          record.entityType === "run",
      );

    expect(failureNotifications.length).toBeGreaterThan(0);
    expect(
      failureNotifications.some((record) =>
        record.body.includes("worker agent crashed"),
      ),
    ).toBe(true);

    verifyStore.close();
    await runtime.stop("test");
  });
});
