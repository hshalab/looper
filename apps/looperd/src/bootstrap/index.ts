import { constants, access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { type LoadedLooperConfig, loadLooperConfig } from "../config/index";
import { type LooperdRuntime, createLooperdRuntime } from "../runtime/index";
import { type Logger, createLogger } from "./logger";

export interface BootstrapLooperdOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  waitForShutdown?: boolean;
}

export interface BootstrapLooperdResult {
  config: LoadedLooperConfig["config"];
  metadata: LoadedLooperConfig["metadata"];
  logger: Logger;
  runtime: LooperdRuntime;
}

async function ensureWritableDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await access(path, constants.W_OK);
}

async function ensureRuntimePaths(
  config: LoadedLooperConfig["config"],
): Promise<void> {
  await ensureWritableDirectory(config.daemon.logDir);
  await ensureWritableDirectory(dirname(config.storage.dbPath));
  await access(config.daemon.workingDirectory, constants.W_OK);
}

function registerSignalHandlers(runtime: LooperdRuntime, logger: Logger): void {
  const shutdown = (signal: string): void => {
    logger.info("received shutdown signal", { signal });
    void runtime.stop(signal);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

export async function bootstrapLooperd(
  options: BootstrapLooperdOptions = {},
): Promise<BootstrapLooperdResult> {
  const loadedConfig = await loadLooperConfig({
    argv: options.argv,
    env: options.env,
    cwd: options.cwd,
  });

  await ensureRuntimePaths(loadedConfig.config);

  const logger = await createLogger(
    loadedConfig.config.logging,
    loadedConfig.config.daemon.logDir,
  );
  logger.info("looperd bootstrap initialized", {
    configPath: loadedConfig.metadata.configPath,
    configFilePresent: loadedConfig.metadata.configFilePresent,
    toolDetection: loadedConfig.metadata.toolDetection,
  });

  const runtime = createLooperdRuntime({
    config: loadedConfig.config,
    logger,
  });

  await runtime.start();

  if (options.waitForShutdown) {
    registerSignalHandlers(runtime, logger);
    await runtime.waitForShutdown();
  }

  return {
    config: loadedConfig.config,
    metadata: loadedConfig.metadata,
    logger,
    runtime,
  };
}
