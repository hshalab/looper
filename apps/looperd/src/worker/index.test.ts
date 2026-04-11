import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentResult, AgentRunInput } from "../infra/agent";
import { SchedulerQueue } from "../scheduler/index";
import { SqliteStore } from "../storage/sqlite/sqlite-store";
import type { WorktreeRecord } from "../storage/types";
import {
  type WorkerAgentExecution,
  type WorkerAgentExecutor,
  type WorkerGitGateway,
  type WorkerGitHubGateway,
  WorkerLoopRunner,
  type WorkerValidationResult,
} from "./index";

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
  const rootDir = await mkdtemp(join(tmpdir(), "looper-worker-"));
  cleanupPaths.push(rootDir);
  const repoPath = join(rootDir, "repo");
  const worktreeRoot = join(rootDir, "worktrees");
  await mkdir(repoPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(
    join(repoPath, "spec.md"),
    "# Spec\n\nImplement worker loop MVP.\n",
  );

  const store = new SqliteStore({
    dbPath: join(rootDir, "state", "looper.sqlite"),
  });
  store.initialize({ autoMigrate: true });

  const now = new Date("2026-04-11T12:00:00.000Z");
  const nowIso = now.toISOString();

  store.projects.upsert({
    id: "project_1",
    name: "Looper",
    repoPath,
    baseBranch: "main",
    archived: false,
    metadataJson: JSON.stringify({ worktreeRoot }),
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  store.loops.upsert({
    id: "loop_worker_1",
    projectId: "project_1",
    type: "worker",
    targetType: "task",
    targetId: "task:task_1",
    repo: "acme/looper",
    prNumber: null,
    status: "queued",
    configJson: null,
    metadataJson: null,
    lastRunAt: null,
    nextRunAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  store.tasks.upsert({
    id: "task_1",
    projectId: "project_1",
    title: "Implement worker loop",
    description: "Ship the checklist-driven worker loop.",
    status: "in_progress",
    loopId: "loop_worker_1",
    repo: "acme/looper",
    prNumber: null,
    metadataJson: JSON.stringify({ specPath: "spec.md" }),
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  store.taskItems.upsert({
    id: "item_1",
    taskId: "task_1",
    content: "Build the worker runner",
    status: "pending",
    position: 0,
    source: "spec",
    metadataJson: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  store.taskItems.upsert({
    id: "item_2",
    taskId: "task_1",
    content: "Open a pull request",
    status: "pending",
    position: 1,
    source: "spec",
    metadataJson: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  const queue = new SchedulerQueue({
    store,
    retryMaxAttempts: 3,
    retryBaseDelayMs: 0,
    now: () => now,
  });
  queue.enqueue({
    projectId: "project_1",
    loopId: "loop_worker_1",
    taskId: "task_1",
    type: "worker",
    targetType: "task",
    targetId: "task:task_1",
    repo: "acme/looper",
    dedupeKey: "worker:task_1",
  });

  return { rootDir, repoPath, worktreeRoot, store, queue, now };
}

class FakeGitGateway implements WorkerGitGateway {
  public createWorktreeCalls = 0;
  public pushCalls = 0;

  constructor(private readonly worktreeRoot: string) {}

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
    const worktreePath = join(
      this.worktreeRoot,
      input.branch.replace(/[^a-zA-Z0-9._-]+/g, "-"),
    );
    await mkdir(worktreePath, { recursive: true });
    return {
      id: "worktree_1",
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      repoPath: input.repoPath,
      worktreePath,
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

  public async push(): Promise<void> {
    this.pushCalls += 1;
  }
}

class FakeGitHubGateway implements WorkerGitHubGateway {
  public createPullRequestCalls: Array<{
    repo: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body?: string;
    cwd?: string;
  }> = [];

  public async createPullRequest(input: {
    repo: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body?: string;
    cwd?: string;
  }): Promise<{ number?: number; url: string }> {
    this.createPullRequestCalls.push(input);
    return {
      number: 101,
      url: "https://example.test/acme/looper/pull/101",
    };
  }
}

class FakeAgentExecutor implements WorkerAgentExecutor {
  public starts: AgentRunInput[] = [];

  constructor(private readonly results: AgentResult[]) {}

  public async start(input: AgentRunInput): Promise<WorkerAgentExecution> {
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

function completedAgentResult(
  summary: string,
  commits: string[] = [],
): AgentResult {
  return {
    status: "completed",
    summary,
    artifacts: [],
    changedFiles: ["apps/looperd/src/worker/index.ts"],
    commits,
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

describe("WorkerLoopRunner", () => {
  test("opens a pull request after a successful worker run", async () => {
    const fixture = await createFixture();
    const git = new FakeGitGateway(fixture.worktreeRoot);
    const github = new FakeGitHubGateway();
    const agent = new FakeAgentExecutor([
      completedAgentResult("Implemented slice and committed changes", [
        "abc123",
      ]),
    ]);
    const runner = new WorkerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      git,
      github,
      agentExecutor: agent,
      now: () => fixture.now,
      validationRunner: async (): Promise<WorkerValidationResult> => ({
        passed: true,
        summary: "ok",
        output: "ok",
      }),
      openPrStrategy: "all_done",
    });

    const claimed = fixture.queue.claimNext("worker-1");
    if (!claimed) {
      throw new Error("Expected claimed worker queue item");
    }

    const result = await runner.processClaimedItem(claimed);
    expect(result.status).toBe("success");
    expect(result.pullRequestNumber).toBe(101);
    expect(agent.starts).toHaveLength(1);
    expect(git.createWorktreeCalls).toBe(1);
    expect(git.pushCalls).toBe(1);
    expect(github.createPullRequestCalls).toHaveLength(1);
    expect(fixture.store.tasks.getById("task_1")?.prNumber).toBe(101);
    expect(fixture.store.loops.getById("loop_worker_1")?.status).toBe(
      "completed",
    );
    expect(fixture.store.taskItems.getById("item_1")?.status).toBe("done");
    expect(fixture.store.taskItems.getById("item_2")?.status).toBe("done");

    fixture.store.close();
  });

  test("keeps checklist items in progress when validation fails and requeues", async () => {
    const fixture = await createFixture();
    const git = new FakeGitGateway(fixture.worktreeRoot);
    const github = new FakeGitHubGateway();
    const agent = new FakeAgentExecutor([
      completedAgentResult("Implemented slice"),
    ]);
    const runner = new WorkerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      git,
      github,
      agentExecutor: agent,
      now: () => fixture.now,
      validationRunner: async (): Promise<WorkerValidationResult> => ({
        passed: false,
        summary: "tests failed",
        output: "tests failed",
      }),
      openPrStrategy: "all_done",
    });

    const claimed = fixture.queue.claimNext("worker-1");
    if (!claimed) {
      throw new Error("Expected claimed worker queue item");
    }

    const result = await runner.processClaimedItem(claimed);
    expect(result.status).toBe("success");
    expect(result.requeuedQueueItemId).toBeDefined();
    expect(fixture.store.taskItems.getById("item_1")?.status).toBe(
      "in_progress",
    );
    expect(fixture.store.taskItems.getById("item_2")?.status).toBe(
      "in_progress",
    );
    expect(github.createPullRequestCalls).toHaveLength(0);
    expect(fixture.store.loops.getById("loop_worker_1")?.status).toBe("queued");

    fixture.store.close();
  });

  test("resumes from open-pr after a retryable PR creation failure", async () => {
    const fixture = await createFixture();
    const git = new FakeGitGateway(fixture.worktreeRoot);
    const github = new FakeGitHubGateway();
    let failuresRemaining = 1;
    github.createPullRequest = async (input) => {
      github.createPullRequestCalls.push(input);
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("temporary GitHub failure");
      }
      return {
        number: 101,
        url: "https://example.test/acme/looper/pull/101",
      };
    };
    const agent = new FakeAgentExecutor([
      completedAgentResult("Implemented slice and committed changes", [
        "abc123",
      ]),
    ]);
    const runner = new WorkerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      git,
      github,
      agentExecutor: agent,
      now: () => fixture.now,
      validationRunner: async (): Promise<WorkerValidationResult> => ({
        passed: true,
        summary: "ok",
        output: "ok",
      }),
      openPrStrategy: "all_done",
    });

    const firstClaim = fixture.queue.claimNext("worker-1");
    if (!firstClaim) {
      throw new Error("Expected first worker queue item claim");
    }

    const firstResult = await runner.processClaimedItem(firstClaim);
    expect(firstResult.status).toBe("failed");
    expect(firstResult.failureKind).toBe("retryable_after_resume");
    expect(agent.starts).toHaveLength(1);

    const retryClaim = fixture.queue.claimNext("worker-1");
    if (!retryClaim) {
      throw new Error("Expected retry worker queue item claim");
    }

    const retryResult = await runner.processClaimedItem(retryClaim);
    expect(retryResult.status).toBe("success");
    expect(agent.starts).toHaveLength(1);
    expect(retryResult.pullRequestNumber).toBe(101);

    fixture.store.close();
  });

  test("pauses for manual PR opening when auto push is disabled", async () => {
    const fixture = await createFixture();
    const git = new FakeGitGateway(fixture.worktreeRoot);
    const github = new FakeGitHubGateway();
    const agent = new FakeAgentExecutor([
      completedAgentResult("Implemented slice and committed changes", [
        "abc123",
      ]),
    ]);
    const runner = new WorkerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      git,
      github,
      agentExecutor: agent,
      now: () => fixture.now,
      validationRunner: async (): Promise<WorkerValidationResult> => ({
        passed: true,
        summary: "ok",
        output: "ok",
      }),
      openPrStrategy: "all_done",
      allowAutoPush: false,
    });

    const claimed = fixture.queue.claimNext("worker-1");
    if (!claimed) {
      throw new Error("Expected claimed worker queue item");
    }

    const result = await runner.processClaimedItem(claimed);
    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("Auto push disabled");
    expect(git.pushCalls).toBe(0);
    expect(github.createPullRequestCalls).toHaveLength(0);
    expect(fixture.store.loops.getById("loop_worker_1")?.status).toBe(
      "completed",
    );

    fixture.store.close();
  });

  test("skips agent execution when auto commit is disabled", async () => {
    const fixture = await createFixture();
    const git = new FakeGitGateway(fixture.worktreeRoot);
    const github = new FakeGitHubGateway();
    const agent = new FakeAgentExecutor([
      completedAgentResult("Implemented slice and committed changes", [
        "abc123",
      ]),
    ]);
    const runner = new WorkerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      git,
      github,
      agentExecutor: agent,
      now: () => fixture.now,
      validationRunner: async (): Promise<WorkerValidationResult> => ({
        passed: true,
        summary: "ok",
        output: "ok",
      }),
      openPrStrategy: "all_done",
      allowAutoCommit: false,
    });

    const claimed = fixture.queue.claimNext("worker-1");
    if (!claimed) {
      throw new Error("Expected claimed worker queue item");
    }

    const result = await runner.processClaimedItem(claimed);
    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("Auto commit disabled");
    expect(agent.starts).toHaveLength(0);
    expect(git.pushCalls).toBe(0);
    expect(github.createPullRequestCalls).toHaveLength(0);

    fixture.store.close();
  });
});
