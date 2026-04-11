export const AGENT_COMPLETION_MARKER = "__LOOPER_RESULT__";

export function appendCompletionInstruction(prompt: string): string {
  return [
    prompt,
    "When finished, print exactly one final line to stdout in this format:",
    `${AGENT_COMPLETION_MARKER}={"summary":"<one-sentence summary>"}`,
    "Do not wrap that line in markdown.",
    "Do not print anything after that line.",
  ].join("\n\n");
}
