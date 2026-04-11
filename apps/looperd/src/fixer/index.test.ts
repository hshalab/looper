import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentResult, AgentRunInput } from "../infra/agent";
import { SchedulerQueue } from "../scheduler/index";
import { SqliteStore } from "../storage/sqlite/sqlite-store";
import {
  type FixerAgentExecution,
  type FixerAgentExecutor,
  type FixerGitGateway,
  type FixerGitHubGateway,
  FixerLoopRunner,
  type FixerValidationResult,
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
  const rootDir = await mkdtemp(join(tmpdir(), "looper-fixer-"));
  cleanupPaths.push(rootDir);
  const repoPath = join(rootDir, "repo");
  await mkdir(repoPath, { recursive: true });

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
    metadataJson: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  const queue = new SchedulerQueue({
    store,
    retryMaxAttempts: 3,
    retryBaseDelayMs: 5_000,
    now: () => now,
  });

  return { rootDir, repoPath, store, queue, now };
}

class FakeGitHubGateway implements FixerGitHubGateway {
  public viewCalls = 0;

  constructor(
    private readonly options: {
      listPrs?: Array<{ number: number; isDraft?: boolean; state?: string }>;
      views: Array<
        "error" | { comments?: unknown[]; checks?: unknown[]; headSha?: string }
      >;
    },
  ) {}

  public async listOpenPullRequests(_input: {
    repo: string;
    cwd?: string;
    limit?: number;
  }) {
    return (
      this.options.listPrs ?? [{ number: 42, isDraft: false, state: "OPEN" }]
    ).map((pr) => ({
      number: pr.number,
      title: `PR ${pr.number}`,
      state: pr.state ?? "OPEN",
      isDraft: pr.isDraft ?? false,
    }));
  }

  public async viewPullRequest(_input: {
    repo: string;
    prNumber: number;
    cwd?: string;
  }) {
    this.viewCalls += 1;
    const next = this.options.views.shift();
    if (!next) {
      throw new Error("No view response queued");
    }
    if (next === "error") {
      throw new Error("temporary GitHub failure");
    }

    return {
      number: 42,
      title: "Fix me",
      body: "body",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "CHANGES_REQUESTED",
      headRefName: "feature/fixer",
      baseRefName: "main",
      headSha: next.headSha ?? "abc123",
      baseSha: "base123",
      author: "octocat",
      comments: next.comments ?? [],
      reviews: [],
      checks: next.checks ?? [],
    };
  }
}

class FakeGitGateway implements FixerGitGateway {
  public pushCalls = 0;

  public async push(_input: {
    worktreePath: string;
    branch: string;
    remote?: string;
    protectedBranches?: string[];
  }): Promise<void> {
    this.pushCalls += 1;
  }
}

class FakeAgentExecutor implements FixerAgentExecutor {
  public starts: AgentRunInput[] = [];

  constructor(private readonly results: AgentResult[]) {}

  public async start(input: AgentRunInput): Promise<FixerAgentExecution> {
    this.starts.push(input);
    const result = this.results.shift();
    if (!result) {
      throw new Error("No agent result queued");
    }
    return { wait: async () => result };
  }
}

function completedAgentResult(summary: string): AgentResult {
  return {
    status: "completed",
    summary,
    artifacts: [],
    changedFiles: ["apps/looperd/src/fixer/index.ts"],
    commits: ["abc123"],
    rawLogs: { stdout: `${summary}\n`, stderr: "" },
    parseStatus: "parsed",
    completionSignal: "done",
    heartbeatCount: 1,
    resourceUsage: { wallTimeMs: 10, outputBytes: summary.length },
    pid: 111,
  };
}

describe("FixerLoopRunner", () => {
  test("discovers and completes a full successful fixer flow", async () => {
    const fixture = await createFixture();
    const github = new FakeGitHubGateway({
      views: [
        { comments: [{ id: "c1", state: "UNRESOLVED", body: "needs fix" }] },
        { comments: [{ id: "c1", state: "UNRESOLVED", body: "needs fix" }] },
        { comments: [], checks: [] },
      ],
    });
    const git = new FakeGitGateway();
    const agent = new FakeAgentExecutor([completedAgentResult("fixed")]);
    const runner = new FixerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      github,
      git,
      agentExecutor: agent,
      now: () => fixture.now,
      validationRunner: async (): Promise<FixerValidationResult> => ({
        passed: true,
        summary: "ok",
      }),
    });

    const discovery = await runner.discoverPullRequests({
      projectId: "project_1",
      repo: "acme/looper",
    });
    expect(discovery.queueItems).toHaveLength(1);

    const claimed = fixture.queue.claimNext("fixer-1");
    if (!claimed) {
      throw new Error("Expected claimed fixer queue item");
    }

    const result = await runner.processClaimedItem(claimed);
    expect(result.status).toBe("success");
    expect(agent.starts).toHaveLength(1);
    expect(git.pushCalls).toBe(1);
    const run = fixture.store.runs.listByLoop(result.loopId)[0];
    const checkpoint = JSON.parse(run?.checkpointJson ?? "{}");
    expect(checkpoint.recheck.remainingFixItems).toHaveLength(0);

    fixture.store.close();
  });

  test("retries from recheck without rerunning repair after recheck failure", async () => {
    const fixture = await createFixture();
    const github = new FakeGitHubGateway({
      views: [
        { comments: [{ id: "c1", state: "UNRESOLVED", body: "needs fix" }] },
        { comments: [{ id: "c1", state: "UNRESOLVED", body: "needs fix" }] },
        "error",
        { comments: [], checks: [] },
      ],
    });
    const git = new FakeGitGateway();
    const agent = new FakeAgentExecutor([completedAgentResult("fixed")]);
    const runner = new FixerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      github,
      git,
      agentExecutor: agent,
      now: () => fixture.now,
      validationRunner: async (): Promise<FixerValidationResult> => ({
        passed: true,
        summary: "ok",
      }),
    });

    await runner.discoverPullRequests({
      projectId: "project_1",
      repo: "acme/looper",
    });
    const firstClaim = fixture.queue.claimNext("fixer-1");
    if (!firstClaim) {
      throw new Error("Expected first fixer claim");
    }
    const firstResult = await runner.processClaimedItem(firstClaim);
    expect(firstResult.status).toBe("failed");
    expect(firstResult.failureKind).toBe("retryable_after_resume");
    expect(agent.starts).toHaveLength(1);
    expect(git.pushCalls).toBe(1);

    fixture.now.setTime(new Date("2026-04-11T12:00:05.000Z").getTime());
    const retryClaim = fixture.queue.claimNext("fixer-1");
    if (!retryClaim) {
      throw new Error("Expected retry fixer claim");
    }
    const retryResult = await runner.processClaimedItem(retryClaim);
    expect(retryResult.status).toBe("success");
    expect(agent.starts).toHaveLength(1);
    expect(git.pushCalls).toBe(1);

    fixture.store.close();
  });

  test("skips processing when no fix items remain", async () => {
    const fixture = await createFixture();
    const nowIso = fixture.now.toISOString();

    fixture.store.loops.upsert({
      id: "loop_fixer_1",
      projectId: "project_1",
      type: "fixer",
      targetType: "pull_request",
      targetId: "pr:acme/looper:42",
      repo: "acme/looper",
      prNumber: 42,
      status: "queued",
      configJson: null,
      metadataJson: null,
      lastRunAt: null,
      nextRunAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const queueItem = fixture.queue.enqueue({
      projectId: "project_1",
      loopId: "loop_fixer_1",
      type: "fixer",
      targetType: "pull_request",
      targetId: "pr:acme/looper:42",
      repo: "acme/looper",
      prNumber: 42,
      dedupeKey: "fixer:acme/looper:42:abc123:none",
    });

    const github = new FakeGitHubGateway({
      views: [{ comments: [], checks: [] }],
    });
    const git = new FakeGitGateway();
    const agent = new FakeAgentExecutor([completedAgentResult("unused")]);
    const runner = new FixerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      github,
      git,
      agentExecutor: agent,
      now: () => fixture.now,
    });

    const claimed = fixture.queue.claimNext("fixer-1");
    const result = await runner.processClaimedItem(claimed ?? queueItem);
    expect(result.status).toBe("skipped");
    expect(agent.starts).toHaveLength(0);
    expect(git.pushCalls).toBe(0);

    fixture.store.close();
  });

  test("writes audit events for fixer lifecycle and push", async () => {
    const fixture = await createFixture();
    const github = new FakeGitHubGateway({
      views: [
        { comments: [{ id: "c1", state: "UNRESOLVED" }], checks: [] },
        { comments: [{ id: "c1", state: "UNRESOLVED" }], checks: [] },
        { comments: [], checks: [] },
      ],
    });
    const git = new FakeGitGateway();
    const agent = new FakeAgentExecutor([completedAgentResult("fixed")]);
    const runner = new FixerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      github,
      git,
      agentExecutor: agent,
      now: () => fixture.now,
      validationRunner: async (): Promise<FixerValidationResult> => ({
        passed: true,
        summary: "ok",
      }),
    });

    await runner.discoverPullRequests({
      projectId: "project_1",
      repo: "acme/looper",
    });
    const claimed = fixture.queue.claimNext("fixer-1");
    if (!claimed) {
      throw new Error("Expected claimed fixer queue item");
    }

    await runner.processClaimedItem(claimed);

    const eventTypes = fixture.store.events
      .list()
      .map((event) => event.eventType);
    expect(eventTypes).toContain("loop.started");
    expect(eventTypes).toContain("run.started");
    expect(eventTypes).toContain("loop.step.started");
    expect(eventTypes).toContain("loop.step.completed");
    expect(eventTypes).toContain("pr.branch.pushed");

    fixture.store.close();
  });

  test("pauses for manual push when auto push is disabled", async () => {
    const fixture = await createFixture();
    const github = new FakeGitHubGateway({
      views: [
        { comments: [{ id: "c1", state: "UNRESOLVED" }], checks: [] },
        { comments: [{ id: "c1", state: "UNRESOLVED" }], checks: [] },
      ],
    });
    const git = new FakeGitGateway();
    const agent = new FakeAgentExecutor([completedAgentResult("fixed")]);
    const runner = new FixerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      github,
      git,
      agentExecutor: agent,
      now: () => fixture.now,
      validationRunner: async (): Promise<FixerValidationResult> => ({
        passed: true,
        summary: "ok",
      }),
      allowAutoPush: false,
    });

    await runner.discoverPullRequests({
      projectId: "project_1",
      repo: "acme/looper",
    });
    const claimed = fixture.queue.claimNext("fixer-1");
    if (!claimed) {
      throw new Error("Expected claimed fixer queue item");
    }

    const result = await runner.processClaimedItem(claimed);
    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("Auto push disabled");
    expect(git.pushCalls).toBe(0);

    fixture.store.close();
  });

  test("skips agent execution when auto commit is disabled", async () => {
    const fixture = await createFixture();
    const github = new FakeGitHubGateway({
      views: [
        { comments: [{ id: "c1", state: "UNRESOLVED" }], checks: [] },
        { comments: [{ id: "c1", state: "UNRESOLVED" }], checks: [] },
      ],
    });
    const git = new FakeGitGateway();
    const agent = new FakeAgentExecutor([completedAgentResult("fixed")]);
    const runner = new FixerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      github,
      git,
      agentExecutor: agent,
      now: () => fixture.now,
      validationRunner: async (): Promise<FixerValidationResult> => ({
        passed: true,
        summary: "ok",
      }),
      allowAutoCommit: false,
    });

    await runner.discoverPullRequests({
      projectId: "project_1",
      repo: "acme/looper",
    });
    const claimed = fixture.queue.claimNext("fixer-1");
    if (!claimed) {
      throw new Error("Expected claimed fixer queue item");
    }

    const result = await runner.processClaimedItem(claimed);
    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("Auto commit disabled");
    expect(agent.starts).toHaveLength(0);
    expect(git.pushCalls).toBe(0);

    fixture.store.close();
  });

  test("skips risky conflict fixes when policy is disabled", async () => {
    const fixture = await createFixture();
    const github = new FakeGitHubGateway({
      views: [
        { comments: [], checks: [], headSha: "abc123" },
        { comments: [], checks: [], headSha: "abc123" },
      ],
    });
    github.viewPullRequest = async (_input) => ({
      number: 42,
      title: "Fix me",
      body: "body",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "CHANGES_REQUESTED",
      headRefName: "feature/fixer",
      baseRefName: "main",
      headSha: "abc123",
      baseSha: "base123",
      author: "octocat",
      comments: [],
      reviews: [],
      checks: [],
      hasConflicts: true,
    });
    const git = new FakeGitGateway();
    const agent = new FakeAgentExecutor([completedAgentResult("fixed")]);
    const runner = new FixerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      github,
      git,
      agentExecutor: agent,
      now: () => fixture.now,
      validationRunner: async (): Promise<FixerValidationResult> => ({
        passed: true,
        summary: "ok",
      }),
      allowRiskyFixes: false,
    });

    await runner.discoverPullRequests({
      projectId: "project_1",
      repo: "acme/looper",
    });
    const claimed = fixture.queue.claimNext("fixer-1");
    if (!claimed) {
      throw new Error("Expected claimed fixer queue item");
    }

    const result = await runner.processClaimedItem(claimed);
    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("risky conflict fixes");
    expect(agent.starts).toHaveLength(0);
    expect(git.pushCalls).toBe(0);

    fixture.store.close();
  });
});
