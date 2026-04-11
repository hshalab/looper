#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  type ApiClient,
  CliApiError,
  type FetchLike,
  createApiClient,
} from "./client";
import { printJson, printSection, printTable } from "./format";

type Writer = (line: string) => void;

interface CliDeps {
  fetchImpl?: FetchLike;
  loadConfigImpl?: (options: {
    argv: string[];
    env: Record<string, string | undefined>;
    cwd: string;
  }) => Promise<LoadedCliConfig>;
  readFileImpl?: (path: string, encoding: "utf8") => Promise<string>;
  stdout?: Writer;
  stderr?: Writer;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

interface CliContext {
  args: ParsedArgs;
  write: Writer;
  writeError: Writer;
  config: LoadedCliConfig;
  client: ApiClient;
  readFileImpl: (path: string, encoding: "utf8") => Promise<string>;
}

interface LoadedCliConfig {
  config: {
    server: {
      host: string;
      port: number;
      baseUrl?: string;
      localToken?: string;
    };
    daemon: {
      mode: string;
      logDir: string;
    };
  };
  metadata: {
    configPath: string;
  };
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

interface PullRequestRef {
  repo: string;
  prNumber: number;
}

const CONFIG_FLAGS = new Set([
  "config",
  "host",
  "port",
  "db-path",
  "log-dir",
  "daemon-mode",
  "bun-path",
  "git-path",
  "gh-path",
  "osascript-path",
]);

export async function runCli(
  argv: string[],
  deps: CliDeps = {},
): Promise<number> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const cwd = deps.cwd ?? process.cwd();
  const write = deps.stdout ?? ((line) => console.log(line));
  const writeError = deps.stderr ?? ((line) => console.error(line));

  try {
    const args = parseArgs(argv);
    const loadConfigImpl = deps.loadConfigImpl ?? loadCliConfig;
    const config = await loadConfigImpl({
      argv: extractConfigArgs(argv),
      env,
      cwd,
    });
    const client = createApiClient({
      baseUrl:
        config.config.server.baseUrl ??
        `http://${config.config.server.host}:${config.config.server.port}`,
      token: env.LOOPER_TOKEN ?? config.config.server.localToken,
      fetchImpl: deps.fetchImpl,
    });
    const context: CliContext = {
      args,
      write,
      writeError,
      config,
      client,
      readFileImpl: deps.readFileImpl ?? readFile,
    };

    await dispatch(context);
    return 0;
  } catch (error) {
    writeError(formatError(error));
    return 1;
  }
}

async function dispatch(context: CliContext): Promise<void> {
  const [command, subcommand] = context.args.positionals;

  switch (command) {
    case "status":
      return runStatus(context);
    case "project":
      if (subcommand === "add") {
        return runProjectAdd(context);
      }
      break;
    case "config":
      if (subcommand !== "show") {
        throw new Error("Usage: looper config show [--json]");
      }
      return runConfigShow(context);
    case "daemon":
      if (subcommand === "status") {
        return runDaemonStatus(context);
      }
      if (subcommand === "logs") {
        return runDaemonLogs(context);
      }
      break;
    case "loop":
      if (subcommand === "list") {
        return runLoopList(context);
      }
      if (subcommand === "start") {
        return runLoopStart(context);
      }
      if (subcommand === "pause") {
        return runLoopPause(context);
      }
      break;
    case "task":
      if (subcommand === "create") {
        return runTaskCreate(context);
      }
      if (subcommand === "start") {
        return runTaskStart(context);
      }
      if (subcommand === "pause") {
        return runTaskPause(context);
      }
      if (subcommand === "status") {
        return runTaskStatus(context);
      }
      if (subcommand === "show") {
        return runTaskShow(context);
      }
      break;
    case "pr":
      if (subcommand === "list") {
        return runPrList(context);
      }
      if (subcommand === "show") {
        return runPrShow(context);
      }
      if (subcommand === "status") {
        return runPrStatus(context);
      }
      break;
    case "run":
      if (subcommand === "list") {
        return runRunList(context);
      }
      break;
    default:
      break;
  }

  throw new Error(
    "Usage: looper <status|project|config|daemon|loop|task|pr|run> ...",
  );
}

async function runStatus(context: CliContext) {
  const data =
    await context.client.get<Record<string, unknown>>("/api/v1/status");
  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  const status = data as {
    service: Record<string, unknown>;
    storage: Record<string, unknown>;
    scheduler: Record<string, unknown>;
    loops: Record<string, Record<string, unknown>>;
    notifications: Record<string, unknown>;
    tools: Record<string, unknown>;
  };
  printSection(context.write, "Service", [
    ["healthy", status.service.healthy as boolean],
    ["version", status.service.version as string],
    ["daemonMode", status.service.daemonMode as string],
    ["startedAt", status.service.startedAt as string],
  ]);
  context.write("");
  printSection(context.write, "Storage", [
    ["dbPath", status.storage.dbPath as string],
    ["schemaVersion", status.storage.schemaVersion as string],
    ["healthy", status.storage.healthy as boolean],
    [
      "pendingMigrations",
      Array.isArray(status.storage.pendingMigrations)
        ? status.storage.pendingMigrations.join(", ") || "none"
        : "none",
    ],
  ]);
  context.write("");
  printSection(context.write, "Scheduler", [
    ["healthy", status.scheduler.healthy as boolean],
    ["queuedItems", status.scheduler.queuedItems as number],
    ["runningItems", status.scheduler.runningItems as number],
  ]);
  context.write("");
  printTable(
    context.write,
    Object.entries(status.loops).map(([type, summary]) => ({
      type,
      ...summary,
    })),
  );
  context.write("");
  printSection(
    context.write,
    "Tools",
    Object.entries(status.tools) as Array<[string, boolean]>,
  );
  context.write("");
  printSection(
    context.write,
    "Notifications",
    Object.entries(status.notifications) as Array<[string, boolean]>,
  );
}

async function runConfigShow(context: CliContext) {
  const data =
    await context.client.get<Record<string, unknown>>("/api/v1/config");
  printJson(context.write, data);
}

async function runProjectAdd(context: CliContext) {
  const repoPathArg =
    context.args.positionals[2] ?? getFlag(context.args, "repo-path");
  if (!repoPathArg) {
    throw new Error("Usage: looper project add <repo-path>");
  }

  const repoPath = resolve(repoPathArg);
  const id = getFlag(context.args, "id") ?? deriveProjectId(repoPath);
  const name = getFlag(context.args, "name") ?? id;
  const data = await context.client.post<Record<string, unknown>>(
    "/api/v1/projects",
    {
      id,
      name,
      repoPath,
      baseBranch: getFlag(context.args, "base-branch"),
      worktreeRoot: getFlag(context.args, "worktree-root"),
      repo: getFlag(context.args, "repo"),
    },
  );

  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printSection(context.write, "Project added", [
    ["id", data.id as string],
    ["name", data.name as string],
    ["repoPath", data.repoPath as string],
    ["baseBranch", (data.baseBranch as string | null | undefined) ?? "-"],
    ["repo", (data.repo as string | null | undefined) ?? "-"],
    ["discoveredPullRequests", data.discoveredPullRequests as number],
    ["discoveredWorktrees", data.discoveredWorktrees as number],
  ]);

  const warnings = (data.warnings as string[] | undefined) ?? [];
  if (warnings.length > 0) {
    context.write("");
    printSection(
      context.write,
      "Warnings",
      warnings.map((warning, index) => [String(index + 1), warning]),
    );
  }
}

async function runDaemonStatus(context: CliContext) {
  let health: unknown = null;
  let reachable = false;

  try {
    health =
      await context.client.get<Record<string, unknown>>("/api/v1/healthz");
    reachable = true;
  } catch (error) {
    if (!(error instanceof CliApiError)) {
      throw error;
    }
  }

  const data = {
    mode: context.config.config.daemon.mode,
    configPath: context.config.metadata.configPath,
    logDir: context.config.config.daemon.logDir,
    apiReachable: reachable,
    health,
  };

  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printSection(context.write, "Daemon", [
    ["mode", data.mode],
    ["configPath", data.configPath],
    ["logDir", data.logDir],
    ["apiReachable", data.apiReachable],
  ]);
  if (reachable) {
    context.write("");
    printJson(context.write, health);
  }
}

async function runDaemonLogs(context: CliContext) {
  const lineCount = Number(getFlag(context.args, "lines") ?? "50");
  if (!Number.isInteger(lineCount) || lineCount <= 0) {
    throw new Error("--lines must be a positive integer");
  }

  const logPath = join(context.config.config.daemon.logDir, "looperd.log");
  const content = await context.readFileImpl(logPath, "utf8");
  const lines = content.trimEnd().split("\n");
  const selected = lines.slice(-lineCount);

  if (hasFlag(context.args, "json")) {
    return printJson(context.write, { logPath, lines: selected });
  }

  context.write(logPath);
  for (const line of selected) {
    context.write(line);
  }
}

async function runLoopList(context: CliContext) {
  const data = await context.client.get<{
    items: Array<Record<string, unknown>>;
  }>("/api/v1/loops");
  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printTable(
    context.write,
    data.items.map((loop) => ({
      id: loop.id as string,
      type: loop.type as string,
      status: loop.status as string,
      target:
        loop.targetType === "task"
          ? String(loop.targetId ?? "-")
          : `${loop.repo}#${loop.prNumber}`,
      projectId: loop.projectId as string,
    })),
  );
}

async function runLoopStart(context: CliContext) {
  const existingLoopId =
    context.args.positionals[2] ?? getFlag(context.args, "id");
  const data = existingLoopId
    ? await context.client.post<Record<string, unknown>>(
        `/api/v1/loops/${encodeURIComponent(existingLoopId)}/start`,
      )
    : await context.client.post<Record<string, unknown>>(
        "/api/v1/loops",
        await buildLoopCreateBody(context),
      );

  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printSection(context.write, "Loop started", [
    ["id", data.id as string],
    ["type", data.type as string],
    ["status", data.status as string],
  ]);
}

async function buildLoopCreateBody(context: CliContext) {
  const type = requireFlag(context.args, "type");
  const taskId = getFlag(context.args, "task");
  const pr = getFlag(context.args, "pr");

  if (taskId) {
    const task = await context.client.get<Record<string, unknown>>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
    );
    return {
      projectId: task.projectId,
      type,
      targetType: "task",
      taskId,
      status: "running",
    };
  }

  if (pr) {
    const ref = parsePullRequestRef(pr);
    const snapshot = await context.client.get<Record<string, unknown>>(
      `/api/v1/pull-requests/${encodeURIComponent(ref.repo)}/${ref.prNumber}`,
    );
    return {
      projectId: snapshot.projectId,
      type,
      targetType: "pull_request",
      repo: ref.repo,
      prNumber: ref.prNumber,
      status: "running",
    };
  }

  throw new Error(
    "loop start requires --task <task-id> or --pr <repo>#<number>",
  );
}

async function runLoopPause(context: CliContext) {
  const loopId = context.args.positionals[2] ?? getFlag(context.args, "id");
  if (!loopId) {
    throw new Error("Usage: looper loop pause <loop-id>");
  }

  const data = await context.client.post<Record<string, unknown>>(
    `/api/v1/loops/${encodeURIComponent(loopId)}/pause`,
  );

  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printSection(context.write, "Loop paused", [
    ["id", data.id as string],
    ["status", data.status as string],
  ]);
}

async function runTaskCreate(context: CliContext) {
  const data = await context.client.post<Record<string, unknown>>(
    "/api/v1/tasks",
    {
      projectId: requireFlag(context.args, "project"),
      title: requireFlag(context.args, "title"),
      description: getFlag(context.args, "description"),
      specPath: getFlag(context.args, "spec"),
      repo: parseOptionalPullRequestRef(getFlag(context.args, "pr"))?.repo,
      prNumber: parseOptionalPullRequestRef(getFlag(context.args, "pr"))
        ?.prNumber,
      items: getFlags(context.args, "item"),
    },
  );

  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printSection(context.write, "Task created", [
    ["id", data.id as string],
    ["title", data.title as string],
    ["status", data.status as string],
  ]);
}

async function runTaskStart(context: CliContext) {
  const taskId = context.args.positionals[2];
  if (!taskId) {
    throw new Error("Usage: looper task start <task-id>");
  }
  const data = await context.client.post<Record<string, unknown>>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/start`,
  );
  return emitTaskResult(context, data, "Task started");
}

async function runTaskPause(context: CliContext) {
  const taskId = context.args.positionals[2];
  if (!taskId) {
    throw new Error("Usage: looper task pause <task-id>");
  }
  const data = await context.client.post<Record<string, unknown>>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/pause`,
  );
  return emitTaskResult(context, data, "Task paused");
}

async function runTaskStatus(context: CliContext) {
  const taskId = context.args.positionals[2];
  if (!taskId) {
    throw new Error("Usage: looper task status <task-id>");
  }
  const data = await context.client.get<Record<string, unknown>>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}`,
  );

  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printSection(context.write, "Task status", [
    ["id", data.id as string],
    ["title", data.title as string],
    ["status", data.status as string],
    ["loopId", (data.loopId as string | null | undefined) ?? "-"],
    ["specPath", (data.specPath as string | null | undefined) ?? "-"],
  ]);
}

async function runTaskShow(context: CliContext) {
  const taskId = context.args.positionals[2];
  if (!taskId) {
    throw new Error("Usage: looper task show <task-id>");
  }
  const data = await context.client.get<Record<string, unknown>>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}`,
  );

  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  await runTaskStatus(context);
  context.write("");
  printTable(
    context.write,
    ((data.items as Array<Record<string, unknown>> | undefined) ?? []).map(
      (item) => ({
        id: item.id as string,
        status: item.status as string,
        position: item.position as number,
        content: item.content as string,
      }),
    ),
  );
}

async function runPrList(context: CliContext) {
  const data = await context.client.get<{
    items: Array<Record<string, unknown>>;
  }>("/api/v1/pull-requests");
  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printTable(
    context.write,
    data.items.map((item) => ({
      pr: `${item.repo}#${item.prNumber}`,
      title: item.title as string,
      reviewState: item.reviewState as string,
      checks: item.checksSummary as string,
      task: (item.task as { id?: string } | null)?.id ?? "-",
    })),
  );
}

async function runPrShow(context: CliContext) {
  const refText = context.args.positionals[2];
  if (!refText) {
    throw new Error("Usage: looper pr show <repo>#<number>");
  }
  const ref = parsePullRequestRef(refText);
  const data = await context.client.get<Record<string, unknown>>(
    `/api/v1/pull-requests/${encodeURIComponent(ref.repo)}/${ref.prNumber}`,
  );

  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printSection(context.write, "Pull request", [
    ["repo", data.repo as string],
    ["prNumber", data.prNumber as number],
    ["title", data.title as string],
    ["reviewState", data.reviewState as string],
    ["checksSummary", data.checksSummary as string],
  ]);
}

async function runPrStatus(context: CliContext) {
  const refText = context.args.positionals[2];
  if (!refText) {
    throw new Error("Usage: looper pr status <repo>#<number>");
  }
  const ref = parsePullRequestRef(refText);
  const data = await context.client.get<Record<string, unknown>>(
    `/api/v1/pull-requests/${encodeURIComponent(ref.repo)}/${ref.prNumber}/status`,
  );

  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printSection(context.write, "Pull request status", [
    ["pr", `${data.repo}#${data.prNumber}`],
    ["reviewState", data.reviewState as string],
    ["checksSummary", data.checksSummary as string],
    ["unresolvedThreads", data.unresolvedThreadCount as number],
    [
      "latestRunStatus",
      (data.loopStatus as { latestRunStatus?: string } | undefined)
        ?.latestRunStatus ?? "-",
    ],
  ]);
}

async function runRunList(context: CliContext) {
  const loopId = getFlag(context.args, "loop");
  const path = loopId
    ? `/api/v1/runs?loopId=${encodeURIComponent(loopId)}`
    : "/api/v1/runs";
  const data = await context.client.get<{
    items: Array<Record<string, unknown>>;
  }>(path);

  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printTable(
    context.write,
    data.items.map((run) => ({
      id: run.id as string,
      loopId: run.loopId as string,
      status: run.status as string,
      currentStep: (run.currentStep as string | null | undefined) ?? "-",
      startedAt: run.startedAt as string,
    })),
  );
}

function emitTaskResult(
  context: CliContext,
  data: Record<string, unknown>,
  title: string,
) {
  if (hasFlag(context.args, "json")) {
    return printJson(context.write, data);
  }

  printSection(context.write, title, [
    ["id", data.id as string],
    ["status", data.status as string],
    ["loopId", (data.loopId as string | null | undefined) ?? "-"],
  ]);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const trimmed = arg.slice(2);
    const eqIndex = trimmed.indexOf("=");
    const name = eqIndex >= 0 ? trimmed.slice(0, eqIndex) : trimmed;
    const existing = flags.get(name) ?? [];

    if (eqIndex >= 0) {
      existing.push(trimmed.slice(eqIndex + 1));
      flags.set(name, existing);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      existing.push("true");
      flags.set(name, existing);
      continue;
    }

    existing.push(next);
    flags.set(name, existing);
    index += 1;
  }

  return { positionals, flags };
}

function extractConfigArgs(argv: string[]): string[] {
  const extracted: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith("--")) {
      continue;
    }

    const trimmed = arg.slice(2);
    const name = trimmed.split("=")[0] ?? trimmed;
    if (!CONFIG_FLAGS.has(name)) {
      continue;
    }

    extracted.push(arg);
    if (!trimmed.includes("=")) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        extracted.push(next);
        index += 1;
      }
    }
  }

  return extracted;
}

function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

function getFlag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

function getFlags(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

function requireFlag(args: ParsedArgs, name: string): string {
  const value = getFlag(args, name);
  if (!value || value === "true") {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function parsePullRequestRef(value: string): PullRequestRef {
  const match = /^(?<repo>[^#]+)#(?<prNumber>\d+)$/.exec(value);
  if (!match?.groups) {
    throw new Error(`Invalid pull request reference: ${value}`);
  }

  const repo = match.groups.repo;
  const prNumber = match.groups.prNumber;
  if (!repo || !prNumber) {
    throw new Error(`Invalid pull request reference: ${value}`);
  }

  return {
    repo,
    prNumber: Number(prNumber),
  };
}

function parseOptionalPullRequestRef(value: string | undefined) {
  return value ? parsePullRequestRef(value) : undefined;
}

function deriveProjectId(repoPath: string): string {
  const normalized = basename(repoPath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "project";
}

async function loadCliConfig(options: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
}): Promise<LoadedCliConfig> {
  const defaultConfigPath = join(homedir(), ".looper", "config.json");
  const configPath =
    readConfigArg(options.argv, "config") ??
    options.env.LOOPER_CONFIG ??
    defaultConfigPath;
  const fileConfig = await readJsonFile(configPath);

  return {
    config: {
      server: {
        host:
          readConfigArg(options.argv, "host") ??
          options.env.LOOPER_HOST ??
          readString(fileConfig, ["server", "host"]) ??
          "127.0.0.1",
        port:
          Number(
            readConfigArg(options.argv, "port") ?? options.env.LOOPER_PORT,
          ) ||
          readNumber(fileConfig, ["server", "port"]) ||
          4310,
        baseUrl: readString(fileConfig, ["server", "baseUrl"]),
        localToken: options.env.LOOPER_TOKEN,
      },
      daemon: {
        mode:
          readConfigArg(options.argv, "daemon-mode") ??
          options.env.LOOPER_DAEMON_MODE ??
          readString(fileConfig, ["daemon", "mode"]) ??
          "foreground",
        logDir:
          readConfigArg(options.argv, "log-dir") ??
          options.env.LOOPER_LOG_DIR ??
          readString(fileConfig, ["daemon", "logDir"]) ??
          join(homedir(), ".looper", "logs"),
      },
    },
    metadata: { configPath },
  };
}

function readConfigArg(argv: string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || !arg.startsWith(`--${name}`)) {
      continue;
    }

    if (arg.includes("=")) {
      return arg.slice(arg.indexOf("=") + 1);
    }

    const next = argv[index + 1];
    return next && !next.startsWith("--") ? next : undefined;
  }

  return undefined;
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readString(
  value: Record<string, unknown>,
  keys: [string, string],
): string | undefined {
  const nested = value[keys[0]];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    return undefined;
  }

  const field = (nested as Record<string, unknown>)[keys[1]];
  return typeof field === "string" ? field : undefined;
}

function readNumber(
  value: Record<string, unknown>,
  keys: [string, string],
): number | undefined {
  const nested = value[keys[0]];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    return undefined;
  }

  const field = (nested as Record<string, unknown>)[keys[1]];
  return typeof field === "number" ? field : undefined;
}

function formatError(error: unknown): string {
  if (error instanceof CliApiError) {
    return [error.message, error.code, error.requestId]
      .filter(Boolean)
      .join(" | ");
  }

  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
