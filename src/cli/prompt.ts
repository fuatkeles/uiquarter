import { resolve } from "node:path";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { PromptBuilder } from "../ai/PromptBuilder.js";

export async function runPromptCommand(options?: {
  dir?: string;
  budget?: number;
  format?: string;
}): Promise<void> {
  const projectDir = resolve(options?.dir ?? process.cwd());

  const builder = new ContextBuilder(projectDir);

  try {
    await builder.load();
  } catch {
    throw new Error("UIQuarter analysis not found. Run 'uiquarter init' first.");
  }

  const context = builder.buildProjectContext();

  const format = options?.format as "text" | "json" | "md" | undefined;

  const prompt = PromptBuilder.buildPrompt(context, {
    budget: options?.budget,
    format,
  });

  process.stdout.write(prompt);
}
