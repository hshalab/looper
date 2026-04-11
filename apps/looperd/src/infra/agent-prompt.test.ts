import { describe, expect, test } from "bun:test";

import { appendCompletionInstruction } from "./agent-prompt";

describe("appendCompletionInstruction", () => {
  test("appends final marker instructions", () => {
    const prompt = appendCompletionInstruction("Do the task.");

    expect(prompt).toContain("Do the task.");
    expect(prompt).toContain(
      "When finished, print exactly one final line to stdout in this format:",
    );
    expect(prompt).toContain(
      '__LOOPER_RESULT__={"summary":"<one-sentence summary>"}',
    );
    expect(prompt).toContain("Do not wrap that line in markdown.");
    expect(prompt).toContain("Do not print anything after that line.");
  });
});
