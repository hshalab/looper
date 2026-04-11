import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentResult, AgentRunInput } from "../infra/agent";
import { SchedulerQueue } from "../scheduler/index";
import { SqliteStore } from "../storage/sqlite/sqlite-store";
import type { PullRequestSnapshotRecord } from "../storage/types";
import {
  type ReviewerAgentExecution,
  type ReviewerGitHubGateway,
  ReviewerLoopRunner,
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
  const rootDir = await mkdtemp(join(tmpdir(), "looper-reviewer-"));
  cleanupPaths.push(rootDir);
  const repoPath = join(rootDir, "repo");
  await mkdir(repoPath, { recursive: true });

  const store = new SqliteStore({
    dbPath: join(rootDir, "state", "looper.sqlite"),
  });
  store.initialize({ autoMigrate: true });

  const now = new Date("2026-04-11T12:00:00.000Z");
  store.projects.upsert({
    id: "project_1",
    name: "Looper",
    repoPath,
    baseBranch: "main",
    archived: false,
    metadataJson: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  const queue = new SchedulerQueue({
    store,
    retryMaxAttempts: 3,
    retryBaseDelayMs: 5_000,
    now: () => now,
  });

  return { rootDir, repoPath, store, queue, now };
}

class FakeGitHubGateway implements ReviewerGitHubGateway {
  public submitCalls: Array<{
    repo: string;
    prNumber: number;
    event: string;
    body?: string;
  }> = [];
  public submitFailuresRemaining = 0;

  constructor(
    private readonly options: {
      headSha?: string;
      isDraft?: boolean;
      state?: string;
      reviewDecision?: string;
    } = {},
  ) {}

  public async listOpenPullRequests(_input: {
    repo: string;
    cwd?: string;
    limit?: number;
  }) {
    return [
      {
        number: 42,
        title: "Review me",
        state: this.options.state ?? "OPEN",
        isDraft: this.options.isDraft ?? false,
        reviewDecision: this.options.reviewDecision,
        author: "octocat",
      },
      {
        number: 99,
        title: "Draft",
        state: "OPEN",
        isDraft: true,
        reviewDecision: undefined,
        author: "octocat",
      },
    ];
  }

  public async viewPullRequest() {
    return {
      number: 42,
      title: "Review me",
      body: "PR body",
      url: "https://example.test/pr/42",
      state: this.options.state ?? "OPEN",
      isDraft: this.options.isDraft ?? false,
      reviewDecision: this.options.reviewDecision,
      headRefName: "feature",
      baseRefName: "main",
      headSha: this.options.headSha ?? "abc123",
      baseSha: "base123",
      author: "octocat",
      comments: [],
      reviews: [],
      checks: [{ conclusion: "SUCCESS" }],
    };
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
      headSha: this.options.headSha ?? "abc123",
      baseSha: "base123",
      title: "Review me",
      body: "PR body",
      author: "octocat",
      diffRef: "gh:diff",
      checksSummary: "SUCCESS",
      unresolvedThreadCount: 0,
      reviewState: this.options.reviewDecision ?? null,
      payloadJson: JSON.stringify({ diff: "diff --git a/a.ts b/a.ts" }),
      capturedAt: input.capturedAt ?? "2026-04-11T12:00:00.000Z",
      createdAt: input.capturedAt ?? "2026-04-11T12:00:00.000Z",
    };
  }

  public async submitReview(input: {
    repo: string;
    prNumber: number;
    event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
    body?: string;
  }): Promise<void> {
    this.submitCalls.push(input);
    if (this.submitFailuresRemaining > 0) {
      this.submitFailuresRemaining -= 1;
      throw new Error("temporary GitHub failure");
    }
  }
}

class FakeAgentExecutor {
  public starts: AgentRunInput[] = [];

  constructor(private readonly results: AgentResult[]) {}

  public async start(input: AgentRunInput): Promise<ReviewerAgentExecution> {
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

describe("ReviewerLoopRunner", () => {
  test("discovers PRs and completes a full reviewer run", async () => {
    const fixture = await createFixture();
    const github = new FakeGitHubGateway();
    const agent = new FakeAgentExecutor([
      completedAgentResult("Looks good overall"),
    ]);
    const runner = new ReviewerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      github,
      agentExecutor: agent,
      now: () => fixture.now,
    });

    const discovery = await runner.discoverPullRequests({
      projectId: "project_1",
      repo: "acme/looper",
    });

    expect(discovery.queueItems).toHaveLength(1);
    expect(discovery.skipped).toBe(1);

    const claimed = fixture.queue.claimNext("reviewer-worker-1");
    expect(claimed?.status).toBe("running");
    if (!claimed) {
      throw new Error("Expected claimed reviewer queue item");
    }

    const result = await runner.processClaimedItem(claimed);
    expect(result.status).toBe("success");
    expect(github.submitCalls).toHaveLength(1);
    expect(agent.starts).toHaveLength(1);
    expect(
      fixture.store.pullRequestSnapshots.getLatest("acme/looper", 42)?.headSha,
    ).toBe("abc123");
    expect(fixture.store.queue.getById(claimed.id)?.status).toBe("completed");
    expect(fixture.store.loops.list()[0]?.status).toBe("completed");
    expect(fixture.store.runs.listByLoop(result.loopId)[0]?.status).toBe(
      "success",
    );
    expect(
      fixture.store.events
        .listByEntity("pull_request", "acme/looper#42")
        .some((event) => event.eventType === "pr.review.posted"),
    ).toBe(true);

    fixture.store.close();
  });

  test("retries publish from checkpoint without rerunning review", async () => {
    const fixture = await createFixture();
    const github = new FakeGitHubGateway();
    github.submitFailuresRemaining = 1;
    const agent = new FakeAgentExecutor([
      completedAgentResult("Please add tests"),
    ]);
    const runner = new ReviewerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      github,
      agentExecutor: agent,
      now: () => fixture.now,
    });

    await runner.discoverPullRequests({
      projectId: "project_1",
      repo: "acme/looper",
    });
    const firstClaim = fixture.queue.claimNext("reviewer-worker-1");
    if (!firstClaim) {
      throw new Error("Expected first reviewer claim");
    }
    const firstResult = await runner.processClaimedItem(firstClaim);

    expect(firstResult.status).toBe("failed");
    expect(firstResult.failureKind).toBe("retryable_after_resume");
    expect(agent.starts).toHaveLength(1);
    expect(github.submitCalls).toHaveLength(1);

    const firstRun = fixture.store.runs.listByLoop(firstResult.loopId)[0];
    const firstCheckpoint = JSON.parse(firstRun?.checkpointJson ?? "{}");
    expect(firstRun?.lastCompletedStep).toBe("review");
    expect(firstCheckpoint.pendingReview.body).toContain("Please add tests");
    expect(fixture.store.queue.getById(firstClaim.id)?.status).toBe("queued");

    fixture.now.setTime(new Date("2026-04-11T12:00:05.000Z").getTime());
    const retryClaim = fixture.queue.claimNext("reviewer-worker-1");
    if (!retryClaim) {
      throw new Error("Expected retry reviewer claim");
    }
    const retryResult = await runner.processClaimedItem(retryClaim);

    expect(retryResult.status).toBe("success");
    expect(agent.starts).toHaveLength(1);
    expect(github.submitCalls).toHaveLength(2);
    expect(fixture.store.queue.getById(retryClaim.id)?.status).toBe(
      "completed",
    );
    expect(fixture.store.loops.getById(retryResult.loopId)?.status).toBe(
      "completed",
    );
    expect(
      JSON.parse(
        fixture.store.loops.getById(retryResult.loopId)?.metadataJson ?? "{}",
      ),
    ).toMatchObject({
      lastPublishedHeadSha: "abc123",
    });

    fixture.store.close();
  });

  test("skips PRs already reviewed for the same head sha", async () => {
    const fixture = await createFixture();
    const github = new FakeGitHubGateway({ headSha: "abc123" });
    const agent = new FakeAgentExecutor([completedAgentResult("unused")]);
    const loopId = "loop_existing";
    const nowIso = fixture.now.toISOString();

    fixture.store.loops.upsert({
      id: loopId,
      projectId: "project_1",
      type: "reviewer",
      targetType: "pull_request",
      targetId: "pr:acme/looper:42",
      repo: "acme/looper",
      prNumber: 42,
      status: "queued",
      configJson: null,
      metadataJson: JSON.stringify({ lastPublishedHeadSha: "abc123" }),
      lastRunAt: null,
      nextRunAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const queueItem = fixture.queue.enqueue({
      projectId: "project_1",
      loopId,
      type: "reviewer",
      targetType: "pull_request",
      targetId: "pr:acme/looper:42",
      repo: "acme/looper",
      prNumber: 42,
      dedupeKey: "reviewer:acme/looper:42",
    });
    const claimed = fixture.queue.claimNext("reviewer-worker-1");
    const runner = new ReviewerLoopRunner({
      store: fixture.store,
      scheduler: fixture.queue,
      github,
      agentExecutor: agent,
      now: () => fixture.now,
    });

    const result = await runner.processClaimedItem(claimed ?? queueItem);

    expect(result.status).toBe("skipped");
    expect(github.submitCalls).toHaveLength(0);
    expect(agent.starts).toHaveLength(0);
    expect(fixture.store.queue.getById(queueItem.id)?.status).toBe("completed");
    expect(fixture.store.runs.listByLoop(loopId)[0]?.summary).toContain(
      "already-reviewed head",
    );

    fixture.store.close();
  });
});
