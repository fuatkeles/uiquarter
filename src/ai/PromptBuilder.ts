import type { ProjectContext } from "../context/ContextBuilder.js";
import { BudgetPromptBuilder } from "./BudgetPromptBuilder.js";

export class PromptBuilder {
  /**
   * Unified entry point. If a budget is provided, delegates to
   * BudgetPromptBuilder; otherwise falls back to the full prompt.
   */
  static buildPrompt(
    context: ProjectContext,
    options?: { budget?: number; format?: "text" | "json" | "md" },
  ): string {
    if (options?.budget !== undefined) {
      return BudgetPromptBuilder.buildBudgetPrompt(context, {
        budget: options.budget,
        format: options.format,
      });
    }
    return PromptBuilder.buildProjectExplanationPrompt(context);
  }

  static buildProjectExplanationPrompt(context: ProjectContext): string {
    const lines: string[] = [];

    lines.push("You are analyzing a software architecture.");
    lines.push("");
    lines.push("Project Summary:");
    lines.push("");
    lines.push(`Components: ${context.summary.totalComponents}`);
    lines.push(`Hub Components: ${context.summary.hubCount}`);
    lines.push(`Deep Chains: ${context.summary.deepChainCount}`);
    lines.push(`Insights: ${context.summary.totalInsights}`);

    if (context.hubs.length > 0) {
      lines.push("");
      lines.push("Hub Components:");
      lines.push("");
      for (const hub of context.hubs) {
        lines.push(`* ${hub.component} (dependents ${hub.dependentCount})`);
      }
    }

    if (context.deepChains.length > 0) {
      lines.push("");
      lines.push("Deep Dependency Chains:");
      lines.push("");
      for (const chain of context.deepChains) {
        if (chain.components.length > 0) {
          lines.push(chain.components.join(" -> "));
        } else {
          lines.push(`${chain.root} -> ... -> ${chain.leaf}`);
        }
      }
    }

    if (context.insights.length > 0) {
      lines.push("");
      lines.push("Insights:");
      lines.push("");
      for (const insight of context.insights) {
        lines.push(`[${insight.severity}] ${insight.type} (confidence ${insight.confidence})`);
      }
    }

    lines.push("");
    lines.push("Instructions:");
    lines.push("");
    lines.push("Explain the architecture.");
    lines.push("Identify risks.");
    lines.push("Suggest improvements.");
    lines.push("");
    lines.push("Be concise and technical.");

    return lines.join("\n");
  }
}
