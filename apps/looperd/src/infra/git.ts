import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Store } from "../storage/store";
import type { WorktreeRecord } from "../storage/types";
import { runCommand } from "./command";

export interface GitWorktreeGatewayOptions {
  gitPath: string;
  store?: Store;
  now?: () => Date;
}

export interface CreateWorktreeInput {
  projectId: string;
  taskId?: string;
  repoPath: string;
  worktreeRoot: string;
  branch: string;
  baseBranch: string;
  prNumber?: number;
  protectedBranches?: string[];
}

export interface PrepareWorktreeResult {
  headSha?: string;
  clean: boolean;
}

export interface InspectHeadResult {
  headSha?: string;
  newCommitShas: string[];
  hasUncommittedChanges: boolean;
  changedFiles: string[];
}

export class ProtectedBranchError extends Error {
  constructor(branch: string) {
    super(`Refusing to modify protected branch: ${branch}`);
    this.name = "ProtectedBranchError";
  }
}

export class RemoteHeadChangedError extends Error {
  constructor(
    branch: string,
    public readonly expectedHeadSha?: string,
    public readonly actualHeadSha?: string,
  ) {
    super(
      `Remote head changed for ${branch}: expected ${expectedHeadSha ?? "unknown"}, got ${actualHeadSha ?? "unknown"}`,
    );
    this.name = "RemoteHeadChangedError";
  }
}

export class GitWorktreeGateway {
  private readonly now: () => Date;

  constructor(private readonly options: GitWorktreeGatewayOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async createBranch(input: {
    repoPath: string;
    branch: string;
    startPoint: string;
    protectedBranches?: string[];
  }): Promise<void> {
    this.assertWritableBranch(
      input.branch,
      input.protectedBranches ?? [input.startPoint],
    );
    await this.runGit(
      ["branch", "--force", input.branch, input.startPoint],
      input.repoPath,
    );
  }

  public async createWorktree(
    input: CreateWorktreeInput,
  ): Promise<WorktreeRecord> {
    this.assertWritableBranch(input.branch, [
      ...(input.protectedBranches ?? []),
      input.baseBranch,
    ]);

    await mkdir(input.worktreeRoot, { recursive: true });
    const worktreePath = join(
      input.worktreeRoot,
      buildWorktreeDirectoryName(input),
    );
    const existing = await this.restoreWorktree({
      projectId: input.projectId,
      repoPath: input.repoPath,
      branch: input.branch,
    });

    if (existing) {
      return existing;
    }

    const branchExists = await this.branchExists(input.repoPath, input.branch);
    await this.runGit(
      branchExists
        ? ["worktree", "add", "--force", worktreePath, input.branch]
        : [
            "worktree",
            "add",
            "--force",
            "-b",
            input.branch,
            worktreePath,
            input.baseBranch,
          ],
      input.repoPath,
    );

    const headSha = await this.getHeadSha(worktreePath);
    const nowIso = this.now().toISOString();
    const record: WorktreeRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      repoPath: input.repoPath,
      worktreePath,
      branch: input.branch,
      baseBranch: input.baseBranch,
      status: "active",
      headSha,
      metadataJson: JSON.stringify({ recovered: false }),
      createdAt: nowIso,
      updatedAt: nowIso,
      cleanedAt: null,
    };
    this.options.store?.worktrees.upsert(record);

    return record;
  }

  public async listWorktrees(
    repoPath: string,
  ): Promise<
    Array<{ path: string; branch?: string; headSha?: string; bare: boolean }>
  > {
    const result = await this.runGit(
      ["worktree", "list", "--porcelain"],
      repoPath,
    );
    return parseWorktreeList(result.stdout);
  }

  public async detectGitHubRepo(repoPath: string): Promise<string | null> {
    const result = await this.runGit(
      ["config", "--get", "remote.origin.url"],
      repoPath,
    );
    return parseGitHubRepoFromRemoteUrl(result.stdout.trim());
  }

  public async restoreWorktree(input: {
    projectId: string;
    repoPath: string;
    branch: string;
  }): Promise<WorktreeRecord | null> {
    const worktrees = await this.listWorktrees(input.repoPath);
    const match = worktrees.find(
      (worktree) => worktree.branch === input.branch,
    );

    if (!match) {
      return null;
    }

    const nowIso = this.now().toISOString();
    const record: WorktreeRecord = this.options.store?.worktrees.getByBranch(
      input.projectId,
      input.branch,
    ) ?? {
      id: randomUUID(),
      projectId: input.projectId,
      taskId: null,
      repoPath: input.repoPath,
      worktreePath: match.path,
      branch: input.branch,
      baseBranch: input.branch,
      status: "active",
      headSha: match.headSha ?? null,
      metadataJson: JSON.stringify({ recovered: true }),
      createdAt: nowIso,
      updatedAt: nowIso,
      cleanedAt: null,
    };

    const restored = {
      ...record,
      worktreePath: match.path,
      headSha: match.headSha ?? null,
      status: "active",
      updatedAt: nowIso,
    };
    this.options.store?.worktrees.upsert(restored);
    return restored;
  }

  public async cleanupWorktree(input: {
    projectId: string;
    repoPath: string;
    worktreePath: string;
    branch: string;
    protectedBranches?: string[];
  }): Promise<void> {
    this.assertWritableBranch(input.branch, input.protectedBranches ?? []);
    await this.runGit(
      ["worktree", "remove", "--force", input.worktreePath],
      input.repoPath,
    );

    const existing = this.options.store?.worktrees.getByBranch(
      input.projectId,
      input.branch,
    );
    if (existing) {
      const nowIso = this.now().toISOString();
      this.options.store?.worktrees.upsert({
        ...existing,
        status: "cleaned",
        cleanedAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  public async push(input: {
    worktreePath: string;
    branch: string;
    remote?: string;
    expectedRemoteHeadSha?: string;
    protectedBranches?: string[];
  }): Promise<void> {
    this.assertWritableBranch(input.branch, input.protectedBranches ?? []);
    const remote = input.remote ?? "origin";
    if (input.expectedRemoteHeadSha) {
      const actualHeadSha = await this.getRemoteHeadSha({
        repoPath: input.worktreePath,
        remote,
        branch: input.branch,
      });
      if (actualHeadSha !== input.expectedRemoteHeadSha) {
        throw new RemoteHeadChangedError(
          input.branch,
          input.expectedRemoteHeadSha,
          actualHeadSha,
        );
      }
    }
    await this.runGit(["push", "-u", remote, input.branch], input.worktreePath);
  }

  public async prepareWorktree(input: {
    worktreePath: string;
    branch: string;
    expectedHeadSha?: string;
    remote?: string;
  }): Promise<PrepareWorktreeResult> {
    const remote = input.remote ?? "origin";
    await this.runGit(["fetch", remote, input.branch], input.worktreePath);
    const remoteRef = `${remote}/${input.branch}`;
    const remoteHeadSha = await this.getRevision(input.worktreePath, remoteRef);
    if (input.expectedHeadSha && remoteHeadSha !== input.expectedHeadSha) {
      throw new RemoteHeadChangedError(
        input.branch,
        input.expectedHeadSha,
        remoteHeadSha ?? undefined,
      );
    }

    const statusBeforeReset = await this.readStatus(input.worktreePath);
    if (statusBeforeReset.length > 0) {
      return { headSha: remoteHeadSha ?? undefined, clean: false };
    }

    const localHeadSha = await this.getHeadSha(input.worktreePath);
    if (remoteHeadSha && localHeadSha !== remoteHeadSha) {
      await this.runGit(["reset", "--hard", remoteRef], input.worktreePath);
    }

    const statusAfterReset = await this.readStatus(input.worktreePath);
    return {
      headSha: (await this.getHeadSha(input.worktreePath)) ?? undefined,
      clean: statusAfterReset.length === 0,
    };
  }

  public async inspectHead(input: {
    worktreePath: string;
    baseRef?: string;
  }): Promise<InspectHeadResult> {
    const headSha = (await this.getHeadSha(input.worktreePath)) ?? undefined;
    const newCommitShas = input.baseRef
      ? await this.listCommitsSince(input.worktreePath, input.baseRef)
      : [];
    const status = await this.readStatus(input.worktreePath);

    return {
      headSha,
      newCommitShas,
      hasUncommittedChanges: status.length > 0,
      changedFiles: status.map((entry) => entry.path),
    };
  }

  public async commit(input: {
    worktreePath: string;
    message: string;
  }): Promise<{ commitSha: string }> {
    await this.runGit(["add", "-A"], input.worktreePath);
    await this.runGit(["commit", "-m", input.message], input.worktreePath, {
      GIT_AUTHOR_NAME: "looperd",
      GIT_AUTHOR_EMAIL: "looperd@example.invalid",
      GIT_COMMITTER_NAME: "looperd",
      GIT_COMMITTER_EMAIL: "looperd@example.invalid",
    });

    return {
      commitSha: requireString(
        await this.getHeadSha(input.worktreePath),
        "commitSha",
      ),
    };
  }

  public assertWritableBranch(
    branch: string,
    protectedBranches: string[],
  ): void {
    if (protectedBranches.includes(branch)) {
      throw new ProtectedBranchError(branch);
    }
  }

  private async getHeadSha(repoPath: string): Promise<string | null> {
    const result = await this.runGit(["rev-parse", "HEAD"], repoPath);
    return result.stdout.trim() || null;
  }

  private async branchExists(
    repoPath: string,
    branch: string,
  ): Promise<boolean> {
    try {
      await this.runGit(
        ["show-ref", "--verify", `refs/heads/${branch}`],
        repoPath,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async getRemoteHeadSha(input: {
    repoPath: string;
    remote: string;
    branch: string;
  }): Promise<string | undefined> {
    const result = await this.runGit(
      ["ls-remote", "--heads", input.remote, input.branch],
      input.repoPath,
    );
    const line = result.stdout.trim().split(/\r?\n/)[0] ?? "";
    const sha = line.split(/\s+/)[0];
    return sha || undefined;
  }

  private async getRevision(
    repoPath: string,
    ref: string,
  ): Promise<string | null> {
    const result = await this.runGit(["rev-parse", ref], repoPath);
    return result.stdout.trim() || null;
  }

  private async listCommitsSince(
    repoPath: string,
    baseRef: string,
  ): Promise<string[]> {
    const result = await this.runGit(
      ["rev-list", "--reverse", `${baseRef}..HEAD`],
      repoPath,
    );
    return result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private async readStatus(
    repoPath: string,
  ): Promise<Array<{ code: string; path: string }>> {
    const result = await this.runGit(
      ["status", "--porcelain", "--untracked-files=all"],
      repoPath,
    );
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => ({
        code: line.slice(0, 2),
        path: line.slice(3).trim(),
      }));
  }

  private async runGit(
    args: string[],
    cwd: string,
    env?: Record<string, string | undefined>,
  ) {
    return runCommand({
      command: this.options.gitPath,
      args,
      cwd,
      env,
    });
  }
}

function buildWorktreeDirectoryName(input: CreateWorktreeInput): string {
  if (typeof input.prNumber === "number") {
    return `looper-fix-${sanitizeBranchName(input.projectId)}-pr-${input.prNumber}`;
  }

  return sanitizeBranchName(input.branch);
}

function requireString(
  value: string | null | undefined,
  fieldName: string,
): string {
  if (!value) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function parseGitHubRepoFromRemoteUrl(remoteUrl: string): string | null {
  if (!remoteUrl) {
    return null;
  }

  const sshMatch = /^git@github\.com:(?<repo>.+?)(?:\.git)?$/.exec(remoteUrl);
  if (sshMatch?.groups?.repo) {
    return sshMatch.groups.repo;
  }

  const sshProtocolMatch =
    /^ssh:\/\/git@github\.com\/(?<repo>.+?)(?:\.git)?$/.exec(remoteUrl);
  if (sshProtocolMatch?.groups?.repo) {
    return sshProtocolMatch.groups.repo;
  }

  const httpsMatch = /^https:\/\/github\.com\/(?<repo>.+?)(?:\.git)?$/.exec(
    remoteUrl,
  );
  if (httpsMatch?.groups?.repo) {
    return httpsMatch.groups.repo;
  }

  return null;
}

function sanitizeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function parseWorktreeList(output: string): Array<{
  path: string;
  branch?: string;
  headSha?: string;
  bare: boolean;
}> {
  const entries: Array<{
    path: string;
    branch?: string;
    headSha?: string;
    bare: boolean;
  }> = [];
  let current: {
    path?: string;
    branch?: string;
    headSha?: string;
    bare: boolean;
  } = {
    bare: false,
  };

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.path) {
        entries.push({
          path: current.path,
          branch: current.branch,
          headSha: current.headSha,
          bare: current.bare,
        });
      }
      current = { bare: false };
      continue;
    }

    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line.startsWith("HEAD ")) {
      current.headSha = line.slice("HEAD ".length);
    } else if (line === "bare") {
      current.bare = true;
    }
  }

  if (current.path) {
    entries.push({
      path: current.path,
      branch: current.branch,
      headSha: current.headSha,
      bare: current.bare,
    });
  }

  return entries;
}
