import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { LoggingConfig } from "../config/index";

const LOG_PRIORITIES = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export async function createLogger(
  config: LoggingConfig,
  logDir: string,
): Promise<Logger> {
  await mkdir(logDir, { recursive: true });
  const logFilePath = join(logDir, "looperd.log");

  const write = (
    level: keyof typeof LOG_PRIORITIES,
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    if (LOG_PRIORITIES[level] < LOG_PRIORITIES[config.level]) {
      return;
    }

    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      context,
    };

    const line = `${JSON.stringify(entry)}\n`;
    void appendFile(logFilePath, line).catch((error) => {
      console.error(`failed to write looperd log: ${(error as Error).message}`);
    });

    if (level === "error" || level === "warn") {
      console.error(line.trim());
      return;
    }

    console.log(line.trim());
  };

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
