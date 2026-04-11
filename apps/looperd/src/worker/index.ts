import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { Logger } from "../bootstrap/logger";
import type { OpenPrStrategy } from "../config/index";
import type { AgentResult, AgentRunInput } from "../infra/agent";
import { appendCompletionInstruction } from "../infra/agent-prompt";
import { CommandExecutionError, runCommand } from "../infra/command";
import { ProtectedBranchError } from "../infra/git";
import type { SchedulerQueue } from "../scheduler/index";
import type { Store } from "../storage/store";
import type {
  LoopRecord,
  ProjectRecord,
  QueueFailureKind,
  QueueItemRecord,
  RunRecord,
  TaskItemRecord,
  TaskRecord,
  WorktreeRecord,
} from "../storage/types";

const WORKER_STEP_SEQUENCE = [
  "prepare-task",
  "prepare-worktree",
  "plan-step",
  "execute-step",
  "validate-step",
  "sync-checklist",
  "open-pr",
] as const;

export type WorkerStep = (typeof WORKER_STEP_SEQUENCE)[number];

export interface WorkerGitGateway {
  createWorktree(input: {
    projectId: string;
    taskId?: string;
    repoPath: string;
    worktreeRoot: string;
    branch: string;
    baseBranch: string;
    protectedBranches?: string[];
  }): Promise<WorktreeRecord>;
  push(input: {
    worktreePath: string;
    branch: string;
    remote?: string;
    protectedBranches?: string[];
  }): Promise<void>;
}

export interface WorkerGitHubGateway {
  createPullRequest(input: {
    repo: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body?: string;
    cwd?: string;
  }): Promise<{ number?: number; url: string }>;
}

export interface WorkerAgentExecution {
  wait(): Promise<AgentResult>;
}

export interface WorkerAgentExecutor {
  start(input: AgentRunInput): Promise<WorkerAgentExecution>;
}

export interface WorkerValidationResult {
  passed: boolean;
  summary?: string;
  output?: string;
}

export interface WorkerLoopRunnerOptions {
  store: Store;
  scheduler: SchedulerQueue;
  git: WorkerGitGateway;
  github: WorkerGitHubGateway;
  agentExecutor: WorkerAgentExecutor;
  logger: Logger;
  onAgentExecutionStarted?: (input: {
    executionId: string;
    projectId: string;
    loopId: string;
    runId: string;
    body: string;
    dedupeKey: string;
  }) => Promise<void> | void;
  now?: () => Date;
  agentTimeoutMs?: number;
  claimTtlMs?: number;
  validationCommands?: string[];
  validationRunner?: (input: {
    cwd: string;
    commands: string[];
  }) => Promise<WorkerValidationResult>;
  openPrStrategy?: OpenPrStrategy;
  allowAutoCommit?: boolean;
  allowAutoPush?: boolean;
}

export interface WorkerProcessResult {
  loopId: string;
  runId: string;
  queueItemId: string;
  status: "success" | "skipped" | "failed";
  summary: string;
  failureKind?: QueueFailureKind;
  requeuedQueueItemId?: string;
  pullRequestNumber?: number;
}

interface WorkerCheckpoint {
  resumePolicy?:
    | "replay_step"
    | "advance_from_checkpoint"
    | "manual_intervention";
  task?: {
    id: string;
    title: string;
    description?: string | null;
    repo: string;
    baseBranch: string;
    specPath?: string | null;
  };
  claimedLockKey?: string;
  worktree?: {
    id: string;
    path: string;
    branch: string;
    baseBranch: string;
  };
  plannedItemIds?: string[];
  execution?: {
    status: AgentResult["status"];
    summary?: string;
    changedFiles: string[];
    commits: string[];
    stdout: string;
  };
  validation?: WorkerValidationResult;
  syncedItemIds?: string[];
  remainingItemIds?: string[];
  allItemsDone?: boolean;
  pullRequest?: {
    number?: number;
    url: string;
  };
  skipReason?: string;
}

interface ResumedRunContext {
  run: RunRecord;
  startStep: WorkerStep;
  checkpoint: WorkerCheckpoint;
  resumed: boolean;
}

class WorkerLoopError extends Error {
  constructor(
    message: string,
    public readonly kind: QueueFailureKind,
  ) {
    super(message);
    this.name = "WorkerLoopError";
  }
}

export class WorkerLoopRunner {
  private readonly now: () => Date;
  private readonly agentTimeoutMs: number;
  private readonly claimTtlMs: number;
  private readonly validationCommands: string[];
  private readonly openPrStrategy: OpenPrStrategy;
  private readonly allowAutoCommit: boolean;
  private readonly allowAutoPush: boolean;

  constructor(private readonly options: WorkerLoopRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.agentTimeoutMs = options.agentTimeoutMs ?? 30 * 60_000;
    this.claimTtlMs = options.claimTtlMs ?? 10 * 60_000;
    this.validationCommands = options.validationCommands ?? [];
    this.openPrStrategy = options.openPrStrategy ?? "all_done";
    this.allowAutoCommit = options.allowAutoCommit ?? true;
    this.allowAutoPush = options.allowAutoPush ?? true;
  }

  public async processNext(
    claimedBy: string,
  ): Promise<WorkerProcessResult | null> {
    const item = this.options.scheduler.claimNextOfType(claimedBy, "worker");
    if (!item) {
      return null;
    }

    return this.processClaimedItem(item);
  }

  public async processClaimedItem(
    queueItem: QueueItemRecord,
  ): Promise<WorkerProcessResult> {
    if (queueItem.type !== "worker") {
      throw new Error(`Unsupported queue item type: ${queueItem.type}`);
    }
    if (!queueItem.loopId || !queueItem.taskId) {
      throw new Error("Worker queue item requires loopId and taskId");
    }

    const loop = this.getLoop(queueItem.loopId);
    const project = this.getProject(loop.projectId);
    const task = this.getTask(queueItem.taskId);
    const resumedRun = this.createRunContext(loop);
    let run = resumedRun.run;
    let checkpoint = resumedRun.checkpoint;
    let claimedLockKey =
      resumedRun.startStep !== "prepare-task"
        ? checkpoint.claimedLockKey
        : undefined;

    if (claimedLockKey) {
      const acquired = this.options.scheduler.acquireBusinessLock({
        key: claimedLockKey,
        owner: queueItem.id,
        reason: "worker-run-resume",
        expiresAt: new Date(
          this.now().getTime() + this.claimTtlMs,
        ).toISOString(),
      });
      if (!acquired) {
        throw new WorkerLoopError(
          `Task lock is already held for ${claimedLockKey}`,
          "retryable_transient",
        );
      }
    }

    this.updateLoop(loop, {
      status: "running",
      lastRunAt: run.startedAt,
      nextRunAt: null,
    });
    this.appendEvent({
      eventType: "loop.started",
      projectId: project.id,
      loopId: loop.id,
      runId: run.id,
      entityType: "loop",
      entityId: loop.id,
      payload: {
        queueItemId: queueItem.id,
        taskId: task.id,
        resumed: resumedRun.resumed,
        startStep: resumedRun.startStep,
      },
    });
    this.options.logger.info("worker loop started", {
      projectId: project.id,
      loopId: loop.id,
      runId: run.id,
      taskId: task.id,
      queueItemId: queueItem.id,
      currentStep: resumedRun.startStep,
      resumed: resumedRun.resumed,
    });
    this.appendEvent({
      eventType: "run.started",
      projectId: project.id,
      loopId: loop.id,
      runId: run.id,
      entityType: "run",
      entityId: run.id,
      payload: {
        queueItemId: queueItem.id,
        currentStep: resumedRun.startStep,
      },
    });
    this.options.logger.info("worker run started", {
      projectId: project.id,
      loopId: loop.id,
      runId: run.id,
      taskId: task.id,
      queueItemId: queueItem.id,
      currentStep: resumedRun.startStep,
    });

    try {
      for (const step of WORKER_STEP_SEQUENCE.slice(
        WORKER_STEP_SEQUENCE.indexOf(resumedRun.startStep),
      )) {
        run = this.persistStepStarted(run, step, checkpoint);
        this.appendEvent({
          eventType: "loop.step.started",
          projectId: project.id,
          loopId: loop.id,
          runId: run.id,
          entityType: "run",
          entityId: run.id,
          payload: { step },
        });
        this.options.logger.info("worker step started", {
          projectId: project.id,
          loopId: loop.id,
          runId: run.id,
          taskId: task.id,
          queueItemId: queueItem.id,
          currentStep: step,
        });

        checkpoint = await this.executeStep({
          step,
          checkpoint,
          project,
          loop,
          run,
          task,
          queueItem,
        });

        if (step === "prepare-task") {
          claimedLockKey = checkpoint.claimedLockKey;
        }

        run = this.persistStepCompleted(run, step, checkpoint);
        this.appendEvent({
          eventType: "loop.step.completed",
          projectId: project.id,
          loopId: loop.id,
          runId: run.id,
          entityType: "run",
          entityId: run.id,
          payload: { step },
        });
        this.options.logger.info("worker step completed", {
          projectId: project.id,
          loopId: loop.id,
          runId: run.id,
          taskId: task.id,
          queueItemId: queueItem.id,
          currentStep: step,
        });

        if (checkpoint.skipReason) {
          break;
        }
      }

      const summary = this.buildSuccessSummary(task, checkpoint);
      this.finalizeRun(run, {
        status: "success",
        summary,
        checkpoint,
      });
      this.appendEvent({
        eventType: "run.completed",
        projectId: project.id,
        loopId: loop.id,
        runId: run.id,
        entityType: "run",
        entityId: run.id,
        payload: { summary },
      });
      this.options.logger.info(
        checkpoint.skipReason ? "worker run skipped" : "worker run completed",
        {
          projectId: project.id,
          loopId: loop.id,
          runId: run.id,
          taskId: task.id,
          queueItemId: queueItem.id,
          currentStep: run.currentStep,
          summary,
        },
      );
      this.options.scheduler.complete(queueItem.id);

      const requeuedItem = this.handlePostRunSuccess({
        loop,
        queueItem,
        task,
        checkpoint,
      });

      return {
        loopId: loop.id,
        runId: run.id,
        queueItemId: queueItem.id,
        status: checkpoint.skipReason ? "skipped" : "success",
        summary,
        requeuedQueueItemId: requeuedItem?.id,
        pullRequestNumber: checkpoint.pullRequest?.number,
      };
    } catch (error) {
      const failure = this.classifyFailure(error);
      this.appendEvent({
        eventType: "loop.step.failed",
        projectId: project.id,
        loopId: loop.id,
        runId: run.id,
        entityType: "run",
        entityId: run.id,
        payload: {
          message: failure.message,
          failureKind: failure.kind,
          currentStep: run.currentStep,
        },
      });
      this.finalizeRun(run, {
        status: "failed",
        summary: failure.message,
        checkpoint: {
          ...checkpoint,
          resumePolicy:
            failure.kind === "retryable_after_resume"
              ? "advance_from_checkpoint"
              : failure.kind === "manual_intervention"
                ? "manual_intervention"
                : (checkpoint.resumePolicy ?? "replay_step"),
        },
        errorMessage: failure.message,
      });
      this.appendEvent({
        eventType: "run.failed",
        projectId: project.id,
        loopId: loop.id,
        runId: run.id,
        entityType: "run",
        entityId: run.id,
        payload: {
          summary: failure.message,
          failureKind: failure.kind,
        },
      });
      this.options.logger.error("worker run failed", {
        projectId: project.id,
        loopId: loop.id,
        runId: run.id,
        taskId: task.id,
        queueItemId: queueItem.id,
        currentStep: run.currentStep,
        failureKind: failure.kind,
        summary: failure.message,
      });

      const failedQueueItem = this.options.scheduler.fail(
        queueItem.id,
        failure.kind,
        failure.message,
      );

      if (failedQueueItem?.status === "queued") {
        this.updateLoop(loop, {
          status: "queued",
          lastRunAt: this.nowIso(),
          nextRunAt: failedQueueItem.availableAt,
        });
      } else {
        this.updateLoop(loop, {
          status: failure.kind === "manual_intervention" ? "paused" : "failed",
          lastRunAt: this.nowIso(),
          nextRunAt: null,
        });
      }

      return {
        loopId: loop.id,
        runId: run.id,
        queueItemId: queueItem.id,
        status: "failed",
        summary: failure.message,
        failureKind: failure.kind,
      };
    } finally {
      if (claimedLockKey) {
        this.options.scheduler.releaseBusinessLock(claimedLockKey);
      }
    }
  }

  private async executeStep(input: {
    step: WorkerStep;
    checkpoint: WorkerCheckpoint;
    project: ProjectRecord;
    loop: LoopRecord;
    run: RunRecord;
    task: TaskRecord;
    queueItem: QueueItemRecord;
  }): Promise<WorkerCheckpoint> {
    switch (input.step) {
      case "prepare-task":
        return this.runPrepareTaskStep(input);
      case "prepare-worktree":
        return this.runPrepareWorktreeStep(input);
      case "plan-step":
        return this.runPlanStep(input);
      case "execute-step":
        return this.runExecuteStep(input);
      case "validate-step":
        return this.runValidateStep(input);
      case "sync-checklist":
        return this.runSyncChecklistStep(input);
      case "open-pr":
        return this.runOpenPrStep(input);
    }
  }

  private async runPrepareTaskStep(input: {
    checkpoint: WorkerCheckpoint;
    project: ProjectRecord;
    queueItem: QueueItemRecord;
    task: TaskRecord;
  }): Promise<WorkerCheckpoint> {
    const repo = requireString(input.task.repo, "task.repo");
    const baseBranch = requireString(
      input.project.baseBranch,
      "project.baseBranch",
    );
    if (this.listTaskItems(input.task.id).length === 0) {
      throw new WorkerLoopError(
        `Task ${input.task.id} has no checklist items`,
        "non_retryable",
      );
    }

    const metadata = parseJsonObject(input.task.metadataJson);
    const specPath = readString(metadata.specPath);
    if (!specPath) {
      throw new WorkerLoopError(
        `Task ${input.task.id} is missing a bound specPath`,
        "non_retryable",
      );
    }

    const lockKey = input.queueItem.lockKey ?? `task:${input.task.id}`;
    const acquired = this.options.scheduler.acquireBusinessLock({
      key: lockKey,
      owner: input.queueItem.id,
      reason: "worker-run",
      expiresAt: new Date(this.now().getTime() + this.claimTtlMs).toISOString(),
    });
    if (!acquired) {
      throw new WorkerLoopError(
        `Task lock is already held for ${lockKey}`,
        "retryable_transient",
      );
    }

    return {
      ...input.checkpoint,
      task: {
        id: input.task.id,
        title: input.task.title,
        description: input.task.description ?? null,
        repo,
        baseBranch,
        specPath,
      },
      claimedLockKey: lockKey,
      resumePolicy: "advance_from_checkpoint",
    };
  }

  private async runPrepareWorktreeStep(input: {
    checkpoint: WorkerCheckpoint;
    project: ProjectRecord;
    task: TaskRecord;
  }): Promise<WorkerCheckpoint> {
    if (input.checkpoint.worktree) {
      return input.checkpoint;
    }

    const taskInfo = requireTaskInfo(input.checkpoint);
    const branch = `looper/task/${input.task.id}`;
    const projectMetadata = parseJsonObject(input.project.metadataJson);
    const configuredRoot = readString(projectMetadata.worktreeRoot);
    const worktreeRoot =
      configuredRoot ?? join(input.project.repoPath, ".looper-worktrees");
    const worktree = await this.options.git.createWorktree({
      projectId: input.project.id,
      taskId: input.task.id,
      repoPath: input.project.repoPath,
      worktreeRoot,
      branch,
      baseBranch: taskInfo.baseBranch,
      protectedBranches: [taskInfo.baseBranch],
    });

    this.updateLoopMetadata(input.task.loopId, {
      worktreeId: worktree.id,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
    });

    return {
      ...input.checkpoint,
      worktree: {
        id: worktree.id,
        path: worktree.worktreePath,
        branch: worktree.branch,
        baseBranch: worktree.baseBranch,
      },
      resumePolicy: "advance_from_checkpoint",
    };
  }

  private async runPlanStep(input: {
    checkpoint: WorkerCheckpoint;
    task: TaskRecord;
  }): Promise<WorkerCheckpoint> {
    const taskItems = this.listTaskItems(input.task.id);
    const planned = taskItems
      .filter(
        (item) => item.status === "in_progress" || item.status === "pending",
      )
      .slice(0, 2);

    if (planned.length === 0) {
      return {
        ...input.checkpoint,
        plannedItemIds: [],
        remainingItemIds: [],
        allItemsDone: true,
        resumePolicy: "advance_from_checkpoint",
      };
    }

    for (const item of planned) {
      if (item.status !== "in_progress") {
        this.options.store.taskItems.upsert({
          ...item,
          status: "in_progress",
          updatedAt: this.nowIso(),
        });
      }
    }

    return {
      ...input.checkpoint,
      plannedItemIds: planned.map((item) => item.id),
      remainingItemIds: taskItems
        .filter((item) => item.status !== "done")
        .map((item) => item.id),
      allItemsDone: false,
      resumePolicy: "advance_from_checkpoint",
    };
  }

  private async runExecuteStep(input: {
    checkpoint: WorkerCheckpoint;
    project: ProjectRecord;
    loop: LoopRecord;
    run: RunRecord;
    task: TaskRecord;
  }): Promise<WorkerCheckpoint> {
    const plannedItems = this.getPlannedItems(input.task.id, input.checkpoint);
    if (plannedItems.length === 0) {
      return {
        ...input.checkpoint,
        execution: {
          status: "completed",
          summary: "No checklist items selected for this run",
          changedFiles: [],
          commits: [],
          stdout: "",
        },
      };
    }
    if (input.checkpoint.execution?.status === "completed") {
      return input.checkpoint;
    }

    if (!this.allowAutoCommit) {
      return {
        ...input.checkpoint,
        skipReason: `Auto commit disabled; manual execution required for task ${input.task.id}`,
        resumePolicy: "manual_intervention",
      };
    }

    const taskInfo = requireTaskInfo(input.checkpoint);
    const worktree = requireWorktree(input.checkpoint);
    const prompt = await buildWorkerPrompt({
      projectRepoPath: input.project.repoPath,
      task: taskInfo,
      items: plannedItems,
    });
    const executionId = randomUUID();
    const execution = await this.options.agentExecutor.start({
      executionId,
      projectId: input.project.id,
      loopId: input.loop.id,
      runId: input.run.id,
      taskId: input.task.id,
      prompt,
      workingDirectory: worktree.path,
      timeoutMs: this.agentTimeoutMs,
      metadata: {
        loopType: "worker",
        taskId: input.task.id,
        plannedItemIds: plannedItems.map((item) => item.id),
      },
      idempotencyKey: `worker:${input.loop.id}:${plannedItems.map((item) => item.id).join(",")}`,
    });
    await this.options.onAgentExecutionStarted?.({
      executionId,
      projectId: input.project.id,
      loopId: input.loop.id,
      runId: input.run.id,
      body: `Worker agent started for task ${input.task.id}`,
      dedupeKey: `runtime.agent.started:worker:${input.run.id}`,
    });
    const result = await execution.wait();

    if (result.status !== "completed") {
      throw new WorkerLoopError(
        result.summary ?? `Worker agent ${result.status}`,
        "retryable_transient",
      );
    }

    return {
      ...input.checkpoint,
      execution: {
        status: result.status,
        summary: result.summary,
        changedFiles: result.changedFiles,
        commits: result.commits,
        stdout: result.rawLogs.stdout,
      },
      resumePolicy: "advance_from_checkpoint",
    };
  }

  private async runValidateStep(input: {
    checkpoint: WorkerCheckpoint;
  }): Promise<WorkerCheckpoint> {
    if ((input.checkpoint.plannedItemIds?.length ?? 0) === 0) {
      return {
        ...input.checkpoint,
        validation: {
          passed: true,
          summary: "No validation required for empty checklist slice",
          output: "",
        },
      };
    }

    const worktree = requireWorktree(input.checkpoint);
    return {
      ...input.checkpoint,
      validation: await this.runValidation({
        cwd: worktree.path,
        commands: this.validationCommands,
      }),
      resumePolicy: "advance_from_checkpoint",
    };
  }

  private async runSyncChecklistStep(input: {
    checkpoint: WorkerCheckpoint;
    project: ProjectRecord;
    loop: LoopRecord;
    run: RunRecord;
    task: TaskRecord;
  }): Promise<WorkerCheckpoint> {
    const plannedItems = this.getPlannedItems(input.task.id, input.checkpoint);
    const passed = input.checkpoint.validation?.passed ?? false;
    const syncedItemIds: string[] = [];

    for (const item of plannedItems) {
      const updated: TaskItemRecord = {
        ...item,
        status: passed ? "done" : "in_progress",
        updatedAt: this.nowIso(),
      };
      this.options.store.taskItems.upsert(updated);
      syncedItemIds.push(item.id);
    }

    const remainingItems = this.listTaskItems(input.task.id).filter(
      (item) => item.status !== "done",
    );
    const allItemsDone = remainingItems.length === 0;
    this.options.store.tasks.upsert({
      ...input.task,
      status: "in_progress",
      updatedAt: this.nowIso(),
    });
    this.appendEvent({
      eventType: "task.checklist.updated",
      projectId: input.project.id,
      loopId: input.loop.id,
      runId: input.run.id,
      entityType: "task",
      entityId: input.task.id,
      payload: {
        syncedItemIds,
        allItemsDone,
        validationPassed: passed,
      },
    });

    return {
      ...input.checkpoint,
      syncedItemIds,
      remainingItemIds: remainingItems.map((item) => item.id),
      allItemsDone,
      resumePolicy: "advance_from_checkpoint",
    };
  }

  private async runOpenPrStep(input: {
    checkpoint: WorkerCheckpoint;
    project: ProjectRecord;
    task: TaskRecord;
  }): Promise<WorkerCheckpoint> {
    if (input.task.prNumber || input.checkpoint.pullRequest) {
      return input.checkpoint;
    }

    const taskInfo = requireTaskInfo(input.checkpoint);
    const worktree = requireWorktree(input.checkpoint);
    const shouldOpen =
      this.openPrStrategy !== "manual" &&
      (Boolean(input.checkpoint.allItemsDone) ||
        (this.openPrStrategy === "first_commit" &&
          (input.checkpoint.execution?.commits.length ?? 0) > 0));

    if (!shouldOpen) {
      return input.checkpoint;
    }

    if (!this.allowAutoPush) {
      return {
        ...input.checkpoint,
        skipReason: `Auto push disabled; manual PR opening required for task ${input.task.id}`,
        resumePolicy: "manual_intervention",
      };
    }

    try {
      await this.options.git.push({
        worktreePath: worktree.path,
        branch: worktree.branch,
        protectedBranches: [taskInfo.baseBranch],
      });
      const pullRequest = await this.options.github.createPullRequest({
        repo: taskInfo.repo,
        headBranch: worktree.branch,
        baseBranch: taskInfo.baseBranch,
        title: taskInfo.title.trim(),
        body: buildPullRequestBody({
          task: taskInfo,
          executionSummary: input.checkpoint.execution?.summary,
          itemContents: this.getPlannedItems(
            input.task.id,
            input.checkpoint,
          ).map((item) => item.content),
        }),
        cwd: input.project.repoPath,
      });

      this.options.store.tasks.upsert({
        ...input.task,
        prNumber: pullRequest.number ?? null,
        updatedAt: this.nowIso(),
      });
      this.updateLoopMetadata(input.task.loopId, {
        prUrl: pullRequest.url,
        prNumber: pullRequest.number ?? null,
      });

      return {
        ...input.checkpoint,
        pullRequest,
        resumePolicy: "advance_from_checkpoint",
      };
    } catch (error) {
      throw new WorkerLoopError(
        error instanceof Error ? error.message : "Failed to open pull request",
        "retryable_after_resume",
      );
    }
  }

  private createRunContext(loop: LoopRecord): ResumedRunContext {
    const latestRun = this.options.store.runs.listByLoop(loop.id)[0] ?? null;
    const nowIso = this.nowIso();
    const checkpoint = parseCheckpoint(latestRun?.checkpointJson);
    const lastCompletedStep = asWorkerStep(latestRun?.lastCompletedStep);
    const startStep =
      latestRun &&
      (latestRun.status === "failed" || latestRun.status === "interrupted") &&
      lastCompletedStep
        ? (nextWorkerStep(lastCompletedStep) ?? "prepare-task")
        : "prepare-task";
    const resumed =
      Boolean(latestRun) &&
      (latestRun?.status === "failed" || latestRun?.status === "interrupted") &&
      startStep !== "prepare-task";

    const run: RunRecord = {
      id: randomUUID(),
      loopId: loop.id,
      status: "running",
      currentStep: startStep,
      lastCompletedStep: resumed ? (lastCompletedStep ?? null) : null,
      checkpointJson: JSON.stringify(
        resumed
          ? { ...checkpoint, resumePolicy: "advance_from_checkpoint" }
          : { resumePolicy: "replay_step" },
      ),
      summary: null,
      errorMessage: null,
      startedAt: nowIso,
      lastHeartbeatAt: nowIso,
      endedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.options.store.runs.upsert(run);

    return {
      run,
      startStep,
      checkpoint: parseCheckpoint(run.checkpointJson),
      resumed,
    };
  }

  private persistStepStarted(
    run: RunRecord,
    step: WorkerStep,
    checkpoint: WorkerCheckpoint,
  ): RunRecord {
    const updated: RunRecord = {
      ...run,
      currentStep: step,
      checkpointJson: JSON.stringify(checkpoint),
      lastHeartbeatAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    this.options.store.runs.upsert(updated);
    return updated;
  }

  private persistStepCompleted(
    run: RunRecord,
    step: WorkerStep,
    checkpoint: WorkerCheckpoint,
  ): RunRecord {
    const updated: RunRecord = {
      ...run,
      currentStep: nextWorkerStep(step),
      lastCompletedStep: step,
      checkpointJson: JSON.stringify(checkpoint),
      lastHeartbeatAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    this.options.store.runs.upsert(updated);
    return updated;
  }

  private finalizeRun(
    run: RunRecord,
    input: {
      status: RunRecord["status"];
      summary: string;
      checkpoint: WorkerCheckpoint;
      errorMessage?: string;
    },
  ): RunRecord {
    const endedAt = this.nowIso();
    const updated: RunRecord = {
      ...run,
      status: input.status,
      summary: input.summary,
      errorMessage: input.errorMessage ?? null,
      checkpointJson: JSON.stringify(input.checkpoint),
      lastHeartbeatAt: endedAt,
      endedAt,
      updatedAt: endedAt,
    };
    this.options.store.runs.upsert(updated);
    return updated;
  }

  private handlePostRunSuccess(input: {
    loop: LoopRecord;
    queueItem: QueueItemRecord;
    task: TaskRecord;
    checkpoint: WorkerCheckpoint;
  }): QueueItemRecord | null {
    const currentTask =
      this.options.store.tasks.getById(input.task.id) ?? input.task;

    if (input.checkpoint.skipReason) {
      this.options.store.tasks.upsert({
        ...currentTask,
        status:
          currentTask.prNumber || this.openPrStrategy === "manual"
            ? "completed"
            : currentTask.status,
        updatedAt: this.nowIso(),
      });
      this.updateLoop(input.loop, {
        status: "completed",
        lastRunAt: this.nowIso(),
        nextRunAt: null,
      });
      return null;
    }

    if ((input.checkpoint.remainingItemIds?.length ?? 0) > 0) {
      const requeued = this.options.scheduler.enqueue({
        projectId: input.queueItem.projectId,
        loopId: input.loop.id,
        taskId: currentTask.id,
        type: "worker",
        targetType: "task",
        targetId: input.queueItem.targetId,
        repo: currentTask.repo,
        dedupeKey: `worker:${currentTask.id}`,
      });
      this.updateLoop(input.loop, {
        status: "queued",
        lastRunAt: this.nowIso(),
        nextRunAt: requeued.availableAt,
      });
      return requeued;
    }

    this.options.store.tasks.upsert({
      ...currentTask,
      status:
        input.checkpoint.pullRequest || this.openPrStrategy === "manual"
          ? "completed"
          : "in_progress",
      updatedAt: this.nowIso(),
    });
    this.updateLoop(input.loop, {
      status: "completed",
      lastRunAt: this.nowIso(),
      nextRunAt: null,
    });
    return null;
  }

  private buildSuccessSummary(
    task: TaskRecord,
    checkpoint: WorkerCheckpoint,
  ): string {
    if (checkpoint.skipReason) {
      return checkpoint.skipReason;
    }
    if (checkpoint.pullRequest?.url) {
      return `Opened pull request for task ${task.id}: ${checkpoint.pullRequest.url}`;
    }
    if ((checkpoint.remainingItemIds?.length ?? 0) > 0) {
      return `Completed checklist slice for task ${task.id}; requeued remaining work`;
    }
    if (this.openPrStrategy === "manual") {
      return `Completed task ${task.id}; PR opening is manual`;
    }
    return `Completed task ${task.id}`;
  }

  private getLoop(loopId: string): LoopRecord {
    const loop = this.options.store.loops.getById(loopId);
    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    return loop;
  }

  private getProject(projectId: string): ProjectRecord {
    const project = this.options.store.projects.getById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    return project;
  }

  private getTask(taskId: string): TaskRecord {
    const task = this.options.store.tasks.getById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return task;
  }

  private listTaskItems(taskId: string): TaskItemRecord[] {
    return this.options.store.taskItems.listByTask(taskId);
  }

  private getPlannedItems(
    taskId: string,
    checkpoint: WorkerCheckpoint,
  ): TaskItemRecord[] {
    const ids = checkpoint.plannedItemIds ?? [];
    const byId = new Map(
      this.listTaskItems(taskId).map((item) => [item.id, item]),
    );
    return ids
      .map((id) => byId.get(id))
      .filter((item): item is TaskItemRecord => Boolean(item));
  }

  private updateLoop(
    loop: LoopRecord,
    updates: Partial<LoopRecord>,
  ): LoopRecord {
    const current = this.options.store.loops.getById(loop.id) ?? loop;
    const updated = {
      ...current,
      ...updates,
      updatedAt: updates.updatedAt ?? this.nowIso(),
    };
    this.options.store.loops.upsert(updated);
    return updated;
  }

  private updateLoopMetadata(
    loopId: string | null | undefined,
    updates: Record<string, unknown>,
  ): void {
    if (!loopId) {
      return;
    }

    const loop = this.options.store.loops.getById(loopId);
    if (!loop) {
      return;
    }

    const metadata = parseJsonObject(loop.metadataJson);
    this.updateLoop(loop, {
      metadataJson: JSON.stringify({ ...metadata, ...updates }),
    });
  }

  private classifyFailure(error: unknown): WorkerLoopError {
    if (error instanceof WorkerLoopError) {
      return error;
    }
    if (error instanceof ProtectedBranchError) {
      return new WorkerLoopError(error.message, "manual_intervention");
    }
    if (error instanceof CommandExecutionError) {
      return new WorkerLoopError(error.message, "retryable_transient");
    }

    return new WorkerLoopError(
      error instanceof Error ? error.message : "Worker loop failed",
      "non_retryable",
    );
  }

  private async runValidation(input: {
    cwd: string;
    commands: string[];
  }): Promise<WorkerValidationResult> {
    if (this.options.validationRunner) {
      return this.options.validationRunner(input);
    }
    if (input.commands.length === 0) {
      return {
        passed: true,
        summary: "No validation commands configured",
        output: "",
      };
    }

    const outputs: string[] = [];
    for (const command of input.commands) {
      try {
        const result = await runCommand({
          command: "/bin/sh",
          args: ["-lc", command],
          cwd: input.cwd,
        });
        outputs.push(result.stdout.trim(), result.stderr.trim());
      } catch (error) {
        const output =
          error instanceof CommandExecutionError
            ? [error.result.stdout, error.result.stderr]
                .filter(Boolean)
                .join("\n")
            : error instanceof Error
              ? error.message
              : "Unknown validation failure";
        return {
          passed: false,
          summary: `Validation failed: ${command}`,
          output,
        };
      }
    }

    return {
      passed: true,
      summary: "Validation passed",
      output: outputs.filter(Boolean).join("\n"),
    };
  }

  private appendEvent(input: {
    eventType: string;
    projectId?: string;
    loopId?: string;
    runId?: string;
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
  }): void {
    this.options.store.events.append({
      id: randomUUID(),
      eventType: input.eventType,
      projectId: input.projectId ?? null,
      loopId: input.loopId ?? null,
      runId: input.runId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      correlationId: null,
      causationId: null,
      actorType: "system",
      actorId: "worker-loop",
      actorDisplayName: "worker-loop",
      payloadJson: JSON.stringify(input.payload),
      createdAt: this.nowIso(),
    });
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function nextWorkerStep(step: WorkerStep): WorkerStep | null {
  const index = WORKER_STEP_SEQUENCE.indexOf(step);
  return WORKER_STEP_SEQUENCE[index + 1] ?? null;
}

function asWorkerStep(value: string | null | undefined): WorkerStep | null {
  return WORKER_STEP_SEQUENCE.includes(value as WorkerStep)
    ? (value as WorkerStep)
    : null;
}

function parseCheckpoint(value?: string | null): WorkerCheckpoint {
  if (!value) {
    return {};
  }

  return parseJsonObject(value) as WorkerCheckpoint;
}

function parseJsonObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireString(
  value: string | null | undefined,
  fieldName: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}

function requireTaskInfo(
  checkpoint: WorkerCheckpoint,
): NonNullable<WorkerCheckpoint["task"]> {
  if (!checkpoint.task) {
    throw new WorkerLoopError(
      "Missing task checkpoint for worker step",
      "retryable_transient",
    );
  }

  return checkpoint.task;
}

function requireWorktree(
  checkpoint: WorkerCheckpoint,
): NonNullable<WorkerCheckpoint["worktree"]> {
  if (!checkpoint.worktree) {
    throw new WorkerLoopError(
      "Missing worktree checkpoint for worker step",
      "retryable_transient",
    );
  }

  return checkpoint.worktree;
}

async function buildWorkerPrompt(input: {
  projectRepoPath: string;
  task: NonNullable<WorkerCheckpoint["task"]>;
  items: TaskItemRecord[];
}): Promise<string> {
  const specBlock = await readSpecBlock(
    input.projectRepoPath,
    input.task.specPath,
  );
  return appendCompletionInstruction(
    [
      `Implement task ${input.task.id}: ${input.task.title}`,
      input.task.description
        ? `Task description:\n${input.task.description}`
        : null,
      `Repository: ${input.task.repo}`,
      `Base branch: ${input.task.baseBranch}`,
      specBlock,
      "Checklist slice:",
      ...input.items.map((item, index) => `${index + 1}. ${item.content}`),
      "Work only on this checklist slice. Make the necessary code changes and stop when the slice is ready for validation.",
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n"),
  );
}

async function readSpecBlock(
  projectRepoPath: string,
  specPath: string | null | undefined,
): Promise<string | null> {
  if (!specPath) {
    return null;
  }

  const resolved = isAbsolute(specPath)
    ? specPath
    : join(projectRepoPath, specPath);
  try {
    const content = await readFile(resolved, "utf8");
    return `Spec (${specPath}):\n${content}`;
  } catch {
    return `Spec path: ${specPath}`;
  }
}

function buildPullRequestBody(input: {
  task: NonNullable<WorkerCheckpoint["task"]>;
  executionSummary?: string;
  itemContents: string[];
}): string {
  return [
    "## Summary",
    ...input.itemContents.map((item) => `- ${item}`),
    input.executionSummary
      ? `\n## Agent Summary\n${input.executionSummary}`
      : null,
    input.task.specPath ? `\nSpec: ${input.task.specPath}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}
