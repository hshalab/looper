import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteStore } from "../storage/sqlite/sqlite-store";
import { GitWorktreeGateway, ProtectedBranchError } from "./git";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

async function runGit(args: string[], cwd: string) {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `git failed: ${args.join(" ")}`);
  }
  return stdout;
}

describe("GitWorktreeGateway", () => {
  test("creates, restores, and cleans worktrees with branch protection", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "looper-git-"));
    cleanupPaths.push(rootDir);
    const repoPath = join(rootDir, "repo");
    const worktreeRoot = join(rootDir, "worktrees");
    await mkdir(repoPath, { recursive: true });

    await runGit(["init", "-b", "main"], repoPath);
    await runGit(["config", "user.email", "test@example.com"], repoPath);
    await runGit(["config", "user.name", "Looper Test"], repoPath);
    await writeFile(join(repoPath, "README.md"), "hello\n");
    await runGit(["add", "README.md"], repoPath);
    await runGit(["commit", "-m", "init"], repoPath);

    const store = new SqliteStore({
      dbPath: join(rootDir, "state", "looper.sqlite"),
    });
    store.initialize({ autoMigrate: true });
    const now = "2026-04-11T12:00:00.000Z";
    store.projects.upsert({
      id: "project_1",
      name: "Looper",
      repoPath,
      baseBranch: "main",
      archived: false,
      metadataJson: null,
      createdAt: now,
      updatedAt: now,
    });

    const gateway = new GitWorktreeGateway({ gitPath: "git", store });
    const worktree = await gateway.createWorktree({
      projectId: "project_1",
      repoPath,
      worktreeRoot,
      branch: "task/123",
      baseBranch: "main",
    });
    const restored = await gateway.restoreWorktree({
      projectId: "project_1",
      repoPath,
      branch: "task/123",
    });

    expect(
      await readFile(join(worktree.worktreePath, "README.md"), "utf8"),
    ).toContain("hello");
    expect(restored?.branch).toBe("task/123");

    await gateway.cleanupWorktree({
      projectId: "project_1",
      repoPath,
      worktreePath: worktree.worktreePath,
      branch: "task/123",
    });
    expect(store.worktrees.getByBranch("project_1", "task/123")?.status).toBe(
      "cleaned",
    );
    expect(() => gateway.assertWritableBranch("main", ["main"])).toThrow(
      ProtectedBranchError,
    );

    store.close();
  });
});
