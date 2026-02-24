import { compare } from "../core/utils.js";
import { QueryEngine } from "../query/QueryEngine.js";
import type { PatternResult, PatternId, Insight } from "../types/index.js";
import type { InsightType } from "../types/insight.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface TaskScopedContext {
  /** The original task description */
  readonly task: string;

  /** Summary stats for this scoped context */
  readonly summary: {
    readonly matchedComponents: number;
    readonly relatedComponents: number;
    readonly relevantInsights: number;
    readonly totalFiles: number;
    readonly estimatedTokens: number;
  };

  /** Primary matches — components directly matching the task */
  readonly matches: readonly TaskMatch[];

  /** Related components — dependencies and dependents of matched components */
  readonly related: readonly RelatedComponent[];

  /** Insights relevant to the matched + related components */
  readonly insights: readonly ScopedInsight[];

  /** Unique file paths involved */
  readonly files: readonly string[];
}

export interface TaskMatch {
  readonly name: string;
  readonly filePath: string;
  readonly type: string;
  readonly framework: string;
  readonly score: number;
  readonly dependencyCount: number;
  readonly dependentCount: number;
}

export interface RelatedComponent {
  readonly name: string;
  readonly filePath: string;
  readonly type: string;
  readonly framework: string;
  readonly relation: "dependency" | "dependent";
  /** Which matched component linked to this one */
  readonly linkedFrom: string;
}

export interface ScopedInsight {
  readonly type: string;
  readonly severity: string;
  readonly confidence: number;
  readonly title: string;
  readonly component?: string;
}

export interface TaskScopedOptions {
  /** Enable fuzzy matching (edit distance 1) */
  readonly fuzzy?: boolean;

  /** Enable synonym expansion */
  readonly synonyms?: boolean;

  /** Maximum number of primary matches to include */
  readonly maxMatches?: number;

  /** Depth of dependency/dependent expansion (default: 1) */
  readonly expansionDepth?: number;

  /** Character budget — if set, output will be trimmed to fit */
  readonly charBudget?: number;
}

// -----------------------------------------------------------------------------
// TaskScopedBuilder
// -----------------------------------------------------------------------------

/**
 * Builds minimal, task-relevant context from the intelligence index.
 *
 * Given a free-form task description, this builder:
 *   1. Resolves matching components via the inverted index + scorer
 *   2. Expands matches to include direct dependencies and dependents
 *   3. Collects relevant insights for all involved components
 *   4. Returns a compact TaskScopedContext within optional budget
 *
 * This is the core of UIQuarter's token-saving strategy for AI tools:
 * instead of sending the entire project context (~5K-50K tokens),
 * only the relevant slice is sent (~200-2K tokens).
 */
export class TaskScopedBuilder {
  private readonly engine: QueryEngine;

  constructor(engine: QueryEngine) {
    this.engine = engine;
  }

  /**
   * Build task-scoped context.
   */
  build(task: string, options?: TaskScopedOptions): TaskScopedContext {
    const maxMatches = options?.maxMatches ?? 10;
    const expansionDepth = options?.expansionDepth ?? 1;

    // 1. Resolve task → scored matches
    const scoredMatches = this.engine.resolveTask(task, {
      fuzzy: options?.fuzzy,
      synonyms: options?.synonyms,
    });

    // Take top N matches
    const topMatches = scoredMatches.slice(0, maxMatches);

    // 2. Build primary match list
    const matches: TaskMatch[] = [];
    const matchedPatternIds = new Set<string>();

    for (const scored of topMatches) {
      const pattern = this.findPatternById(scored.patternId);
      if (pattern === null) continue;

      matchedPatternIds.add(pattern.id as string);

      const deps = this.engine.findDependencies(pattern.name);
      const dependents = this.engine.findDependents(pattern.name);

      matches.push({
        name: pattern.name,
        filePath: pattern.filePath,
        type: pattern.type,
        framework: pattern.framework,
        score: scored.score,
        dependencyCount: deps.length,
        dependentCount: dependents.length,
      });
    }

    // 3. Expand to related components (deps + dependents)
    const related: RelatedComponent[] = [];
    const relatedIds = new Set<string>();

    for (const match of matches) {
      this.expandRelated(
        match.name,
        expansionDepth,
        matchedPatternIds,
        relatedIds,
        related,
      );
    }

    // 4. Collect relevant insights
    const allInvolvedNames = new Set<string>();
    for (const m of matches) allInvolvedNames.add(m.name);
    for (const r of related) allInvolvedNames.add(r.name);

    const insights = this.collectRelevantInsights(allInvolvedNames);

    // 5. Collect unique file paths
    const fileSet = new Set<string>();
    for (const m of matches) fileSet.add(m.filePath);
    for (const r of related) fileSet.add(r.filePath);
    const files = [...fileSet].sort(compare);

    // 6. Build context
    const context: TaskScopedContext = {
      task,
      summary: {
        matchedComponents: matches.length,
        relatedComponents: related.length,
        relevantInsights: insights.length,
        totalFiles: files.length,
        estimatedTokens: 0, // computed below
      },
      matches,
      related,
      insights,
      files,
    };

    // Estimate tokens
    const serialized = JSON.stringify(context);
    const estimatedTokens = Math.ceil(serialized.length / 4); // ~4 chars per token

    // Apply char budget if specified
    if (options?.charBudget !== undefined && options.charBudget > 0) {
      return this.applyBudget(context, estimatedTokens, options.charBudget);
    }

    return {
      ...context,
      summary: { ...context.summary, estimatedTokens },
    };
  }

  /**
   * Build and format as compact text for direct AI consumption.
   */
  buildText(task: string, options?: TaskScopedOptions): string {
    const ctx = this.build(task, options);
    return formatScopedContextText(ctx);
  }

  /**
   * Build and format as markdown.
   */
  buildMarkdown(task: string, options?: TaskScopedOptions): string {
    const ctx = this.build(task, options);
    return formatScopedContextMarkdown(ctx);
  }

  // ---------------------------------------------------------------------------
  // Private: pattern lookup
  // ---------------------------------------------------------------------------

  private findPatternById(patternId: PatternId): PatternResult | null {
    // Extract name from PatternId format: filePath:name:line
    const segments = (patternId as string).split(":");
    if (segments.length < 3) return null;

    const last = segments[segments.length - 1]!;
    const secondLast = segments[segments.length - 2]!;

    let name: string;
    if (/^\d+$/.test(last)) {
      if (secondLast === "dep" && segments.length >= 4) {
        name = segments[segments.length - 3]!;
      } else {
        name = secondLast;
      }
    } else {
      return null;
    }

    return this.engine.findComponent(name);
  }

  // ---------------------------------------------------------------------------
  // Private: expansion
  // ---------------------------------------------------------------------------

  private expandRelated(
    componentName: string,
    depth: number,
    matchedIds: ReadonlySet<string>,
    relatedIds: Set<string>,
    related: RelatedComponent[],
  ): void {
    if (depth <= 0) return;

    // Dependencies
    const deps = this.engine.findDependencies(componentName);
    for (const dep of deps) {
      if (matchedIds.has(dep.id as string)) continue;
      if (relatedIds.has(dep.id as string)) continue;

      relatedIds.add(dep.id as string);
      related.push({
        name: dep.name,
        filePath: dep.filePath,
        type: dep.type,
        framework: dep.framework,
        relation: "dependency",
        linkedFrom: componentName,
      });
    }

    // Dependents
    const dependents = this.engine.findDependents(componentName);
    for (const dep of dependents) {
      if (matchedIds.has(dep.id as string)) continue;
      if (relatedIds.has(dep.id as string)) continue;

      relatedIds.add(dep.id as string);
      related.push({
        name: dep.name,
        filePath: dep.filePath,
        type: dep.type,
        framework: dep.framework,
        relation: "dependent",
        linkedFrom: componentName,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: insight collection
  // ---------------------------------------------------------------------------

  private collectRelevantInsights(
    involvedNames: ReadonlySet<string>,
  ): readonly ScopedInsight[] {
    const allTypes: readonly InsightType[] = [
      "hub-component",
      "orphan-component",
      "dependency-cycle",
      "deep-dependency-chain",
      "mixed-styling",
      "architectural-smell",
    ];

    const result: ScopedInsight[] = [];

    for (const type of allTypes) {
      const insights = this.engine.findInsights(type);
      for (const insight of insights) {
        const component = this.extractComponentFromInsight(insight);
        if (component !== null && involvedNames.has(component)) {
          result.push({
            type: insight.category,
            severity: insight.severity,
            confidence: insight.confidence,
            title: insight.title,
            component,
          });
        }
      }
    }

    return result.sort((a, b) =>
      compare(a.severity, b.severity) ||
      (b.confidence - a.confidence) ||
      compare(a.component ?? "", b.component ?? ""),
    );
  }

  private extractComponentFromInsight(insight: Insight): string | null {
    if (insight.relatedPatterns.length === 0) return null;
    const patternId = insight.relatedPatterns[0] as string;
    const segments = patternId.split(":");
    if (segments.length < 3) return null;

    const last = segments[segments.length - 1]!;
    const secondLast = segments[segments.length - 2]!;

    if (/^\d+$/.test(last)) {
      if (secondLast === "dep" && segments.length >= 4) {
        return segments[segments.length - 3] ?? null;
      }
      return secondLast;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Private: budget trimming
  // ---------------------------------------------------------------------------

  private applyBudget(
    context: TaskScopedContext,
    estimatedTokens: number,
    charBudget: number,
  ): TaskScopedContext {
    // If already within budget, just update tokens
    const serialized = JSON.stringify(context);
    if (serialized.length <= charBudget) {
      return {
        ...context,
        summary: { ...context.summary, estimatedTokens },
      };
    }

    // Progressive trimming: remove insights first, then related, then matches
    let trimmed = context;

    // Try removing insights
    if (JSON.stringify({ ...trimmed, insights: [] }).length > charBudget) {
      trimmed = { ...trimmed, insights: [] };
    }

    // Try removing related components
    if (JSON.stringify({ ...trimmed, related: [] }).length > charBudget) {
      trimmed = { ...trimmed, related: [] };
    }

    // Trim matches if still too large
    let matchCount = trimmed.matches.length;
    while (matchCount > 1 && JSON.stringify({ ...trimmed, matches: trimmed.matches.slice(0, matchCount) }).length > charBudget) {
      matchCount--;
    }
    if (matchCount < trimmed.matches.length) {
      trimmed = { ...trimmed, matches: trimmed.matches.slice(0, matchCount) };
    }

    const finalSerialized = JSON.stringify(trimmed);
    const finalTokens = Math.ceil(finalSerialized.length / 4);

    // Rebuild files from remaining matches + related
    const fileSet = new Set<string>();
    for (const m of trimmed.matches) fileSet.add(m.filePath);
    for (const r of trimmed.related) fileSet.add(r.filePath);

    return {
      ...trimmed,
      files: [...fileSet].sort(compare),
      summary: {
        matchedComponents: trimmed.matches.length,
        relatedComponents: trimmed.related.length,
        relevantInsights: trimmed.insights.length,
        totalFiles: fileSet.size,
        estimatedTokens: finalTokens,
      },
    };
  }
}

// -----------------------------------------------------------------------------
// Text formatters
// -----------------------------------------------------------------------------

function formatScopedContextText(ctx: TaskScopedContext): string {
  const lines: string[] = [];

  lines.push(`Task: "${ctx.task}"`);
  lines.push(`Matched: ${ctx.summary.matchedComponents} components, ${ctx.summary.relatedComponents} related, ${ctx.summary.relevantInsights} insights`);
  lines.push("");

  if (ctx.matches.length > 0) {
    lines.push("Matched Components:");
    for (const m of ctx.matches) {
      lines.push(`  ${m.name} (${m.type}, ${m.framework}) — ${m.filePath}`);
      lines.push(`    deps: ${m.dependencyCount}, dependents: ${m.dependentCount}, score: ${m.score.toFixed(2)}`);
    }
    lines.push("");
  }

  if (ctx.related.length > 0) {
    lines.push("Related Components:");
    for (const r of ctx.related) {
      lines.push(`  ${r.name} (${r.type}) — ${r.relation} of ${r.linkedFrom}`);
    }
    lines.push("");
  }

  if (ctx.insights.length > 0) {
    lines.push("Relevant Insights:");
    for (const i of ctx.insights) {
      const comp = i.component !== undefined ? ` [${i.component}]` : "";
      lines.push(`  [${i.severity}] ${i.type}${comp} — ${i.title}`);
    }
    lines.push("");
  }

  if (ctx.files.length > 0) {
    lines.push("Files:");
    for (const f of ctx.files) {
      lines.push(`  ${f}`);
    }
  }

  return lines.join("\n");
}

function formatScopedContextMarkdown(ctx: TaskScopedContext): string {
  const lines: string[] = [];

  lines.push(`# Task Context: "${ctx.task}"`);
  lines.push("");
  lines.push(`> ${ctx.summary.matchedComponents} matched, ${ctx.summary.relatedComponents} related, ${ctx.summary.relevantInsights} insights, ~${ctx.summary.estimatedTokens} tokens`);
  lines.push("");

  if (ctx.matches.length > 0) {
    lines.push("## Matched Components");
    lines.push("");
    lines.push("| Component | Type | Framework | File | Deps | Dependents | Score |");
    lines.push("|-----------|------|-----------|------|------|------------|-------|");
    for (const m of ctx.matches) {
      lines.push(`| ${m.name} | ${m.type} | ${m.framework} | ${m.filePath} | ${m.dependencyCount} | ${m.dependentCount} | ${m.score.toFixed(2)} |`);
    }
    lines.push("");
  }

  if (ctx.related.length > 0) {
    lines.push("## Related Components");
    lines.push("");
    lines.push("| Component | Type | Relation | Linked From |");
    lines.push("|-----------|------|----------|-------------|");
    for (const r of ctx.related) {
      lines.push(`| ${r.name} | ${r.type} | ${r.relation} | ${r.linkedFrom} |`);
    }
    lines.push("");
  }

  if (ctx.insights.length > 0) {
    lines.push("## Relevant Insights");
    lines.push("");
    for (const i of ctx.insights) {
      const comp = i.component !== undefined ? ` [${i.component}]` : "";
      lines.push(`- **[${i.severity}]** ${i.type}${comp} — ${i.title}`);
    }
    lines.push("");
  }

  if (ctx.files.length > 0) {
    lines.push("## Files");
    lines.push("");
    for (const f of ctx.files) {
      lines.push(`- \`${f}\``);
    }
  }

  return lines.join("\n");
}
