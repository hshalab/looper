declare module "cac" {
  export interface Command {
    name: string;
    aliasNames: string[];
    usage(text: string): this;
    option(name: string, description?: string, config?: unknown): this;
    example(callback: (name: string) => string): this;
    action(
      callback: (options: Record<string, unknown>) => void | Promise<void>,
    ): this;
    action(
      callback: (
        args: string[],
        options: Record<string, unknown>,
      ) => void | Promise<void>,
    ): this;
    outputHelp(): void;
  }

  export interface CAC extends Command {
    command(rawName: string, description?: string): Command;
    help(): this;
    parse(argv?: string[], options?: { run?: boolean }): void;
    runMatchedCommand(): Promise<void>;
    matchedCommand?: Command;
    commands: Command[];
  }

  export function cac(name?: string): CAC;
}
