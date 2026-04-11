import { describe, expect, test } from "bun:test";

import { runCli } from "./index";

function createConfig() {
  return {
    config: {
      server: {
        host: "127.0.0.1",
        port: 4310,
        baseUrl: "http://127.0.0.1:4310",
      },
      daemon: { mode: "foreground", logDir: "/tmp/looper-logs" },
    },
    metadata: {
      configPath: "/tmp/config.json",
    },
  };
}

describe("runCli", () => {
  test("renders status as json", async () => {
    const lines: string[] = [];
    const exitCode = await runCli(["status", "--json"], {
      stdout: (line) => lines.push(line),
      loadConfigImpl: async () => createConfig() as never,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            requestId: "req_1",
            data: { service: { healthy: true } },
          }),
        ),
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain('"healthy": true');
  });

  test("creates task with checklist items and spec path", async () => {
    const requests: Array<{ url: string; body?: string | null }> = [];
    const exitCode = await runCli(
      [
        "task",
        "create",
        "--project",
        "project_1",
        "--title",
        "Ship CLI",
        "--spec",
        "spec.md",
        "--item",
        "first",
        "--item",
        "second",
      ],
      {
        stdout: () => {},
        loadConfigImpl: async () => createConfig() as never,
        fetchImpl: async (input, init) => {
          requests.push({
            url: String(input),
            body: init?.body as string | null,
          });
          return new Response(
            JSON.stringify({
              ok: true,
              requestId: "req_2",
              data: { id: "task_1", title: "Ship CLI", status: "pending" },
            }),
          );
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/api/v1/tasks");
    expect(requests[0]?.body).toContain('"items":["first","second"]');
    expect(requests[0]?.body).toContain('"specPath":"spec.md"');
  });

  test("creates reviewer loop from PR reference", async () => {
    const requests: string[] = [];
    const exitCode = await runCli(
      ["loop", "start", "--type", "reviewer", "--pr", "acme/looper#42"],
      {
        stdout: () => {},
        loadConfigImpl: async () => createConfig() as never,
        fetchImpl: async (input, init) => {
          const url = String(input);
          requests.push(`${init?.method ?? "GET"} ${url}`);

          if (url.endsWith("/api/v1/pull-requests/acme%2Flooper/42")) {
            return new Response(
              JSON.stringify({
                ok: true,
                requestId: "req_3",
                data: {
                  projectId: "project_1",
                  repo: "acme/looper",
                  prNumber: 42,
                },
              }),
            );
          }

          return new Response(
            JSON.stringify({
              ok: true,
              requestId: "req_4",
              data: { id: "loop_1", type: "reviewer", status: "running" },
            }),
          );
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(requests[0]).toContain(
      "GET http://127.0.0.1:4310/api/v1/pull-requests/acme%2Flooper/42",
    );
    expect(requests[1]).toContain("POST http://127.0.0.1:4310/api/v1/loops");
  });

  test("adds project and requests discovery", async () => {
    const requests: Array<{ url: string; body?: string | null }> = [];
    const exitCode = await runCli(["project", "add", "/tmp/repos/looper"], {
      stdout: () => {},
      loadConfigImpl: async () => createConfig() as never,
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          body: init?.body as string | null,
        });
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: "req_project_add",
            data: {
              id: "looper",
              name: "looper",
              repoPath: "/tmp/repos/looper",
              baseBranch: "main",
              repo: "powerformer/looper",
              discoveredPullRequests: 1,
              discoveredWorktrees: 2,
              warnings: [],
            },
          }),
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/api/v1/projects");
    expect(requests[0]?.body).toContain('"id":"looper"');
    expect(requests[0]?.body).toContain('"name":"looper"');
    expect(requests[0]?.body).toContain('"repoPath":"/tmp/repos/looper"');
  });

  test("lists projects", async () => {
    const lines: string[] = [];
    const requests: string[] = [];
    const exitCode = await runCli(["project", "list"], {
      stdout: (line) => lines.push(line),
      loadConfigImpl: async () => createConfig() as never,
      fetchImpl: async (input) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: "req_project_list",
            data: {
              items: [
                {
                  id: "looper",
                  name: "Looper",
                  repoPath: "/tmp/repos/looper",
                  baseBranch: "main",
                  repo: "powerformer/looper",
                  updatedAt: "2026-04-11T00:00:00.000Z",
                },
              ],
            },
          }),
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(requests[0]).toContain("/api/v1/projects");
    expect(lines.join("\n")).toContain("looper");
    expect(lines.join("\n")).toContain("/tmp/repos/looper");
  });

  test("shows daemon logs tail", async () => {
    const lines: string[] = [];
    const exitCode = await runCli(["daemon", "logs", "--lines", "1"], {
      stdout: (line) => lines.push(line),
      loadConfigImpl: async () => createConfig() as never,
      readFileImpl: async () => "one\ntwo\n",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ ok: true, requestId: "req_5", data: {} }),
        ),
    });

    expect(exitCode).toBe(0);
    expect(lines.at(-1)).toBe("two");
  });

  test("lists pull requests with reviewer and fixer status", async () => {
    const lines: string[] = [];
    const exitCode = await runCli(["pr", "list"], {
      stdout: (line) => lines.push(line),
      loadConfigImpl: async () => createConfig() as never,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            requestId: "req_pr_list",
            data: {
              items: [
                {
                  repo: "acme/looper",
                  prNumber: 42,
                  title: "Runtime foundation",
                  reviewState: "changes_requested",
                  checksSummary: "green",
                  reviewer: "running",
                  fixer: "paused",
                  task: { id: "task_1" },
                },
                {
                  repo: "acme/looper",
                  prNumber: 77,
                  title: null,
                  reviewState: null,
                  checksSummary: null,
                  reviewer: "queued",
                  fixer: null,
                  task: null,
                },
              ],
            },
          }),
        ),
    });

    expect(exitCode).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("reviewer");
    expect(output).toContain("fixer");
    expect(output).toContain("running");
    expect(output).toContain("paused");
    expect(output).toContain("queued");
  });

  test("uses server.localToken from config for API auth", async () => {
    const authHeaders: string[] = [];
    const exitCode = await runCli(["status", "--json"], {
      stdout: () => {},
      loadConfigImpl: async () => ({
        config: {
          server: {
            host: "127.0.0.1",
            port: 4310,
            baseUrl: "http://127.0.0.1:4310",
            localToken: "config-token",
          },
          daemon: { mode: "foreground", logDir: "/tmp/looper-logs" },
        },
        metadata: { configPath: "/tmp/config.json" },
      }),
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        authHeaders.push(headers.get("authorization") ?? "");
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: "req_auth",
            data: { service: { healthy: true } },
          }),
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(authHeaders[0]).toBe("Bearer config-token");
  });
});
