import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compare } from "../core/utils.js";
import type { IndexMeta } from "../indexer/IntelligenceIndexer.js";
import type { IndexStats } from "../types/index.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface DriftSnapshot {
  readonly meta: IndexMeta;
  readonly patternIds: readonly string[];
  readonly insightIds: readonly string[];
}

export interface PatternDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly total: { readonly before: number; readonly after: number };
}

export interface InsightDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly total: { readonly before: number; readonly after: number };
}

export interface StatsDiff {
  readonly before: IndexStats;
  readonly after: IndexStats;
  readonly patternDelta: number;
  readonly edgeDelta: number;
  readonly fileDelta: number;
}

export interface DriftReport {
  readonly hashChanged: boolean;
  readonly buildBefore: number;
  readonly buildAfter: number;
  readonly generatedBefore: string;
  readonly generatedAfter: string;
  readonly stats: StatsDiff;
  readonly patterns: PatternDiff;
  readonly insights: InsightDiff;
}

// -----------------------------------------------------------------------------
// Snapshot loader
// -----------------------------------------------------------------------------

export async function loadSnapshot(uiqDir: string): Promise<DriftSnapshot> {
  const metaRaw = await readFile(join(uiqDir, "meta.json"), "utf-8");
  const meta = JSON.parse(metaRaw) as IndexMeta;

  const indexRaw = await readFile(join(uiqDir, "index.json"), "utf-8");
  const index = JSON.parse(indexRaw) as { entries: Record<string, unknown> };
  const patternIds = Object.keys(index.entries).sort(compare);

  let insightIds: string[] = [];
  try {
    const insightsRaw = await readFile(join(uiqDir, "insights.json"), "utf-8");
    const insights = JSON.parse(insightsRaw) as { insights?: readonly { id: string }[] };
    if (Array.isArray(insights.insights)) {
      insightIds = insights.insights.map((i) => i.id).sort(compare);
    }
  } catch {
    // insights.json may not exist in older snapshots
  }

  return { meta, patternIds, insightIds };
}

// -----------------------------------------------------------------------------
// Diff computation
// -----------------------------------------------------------------------------

function diffStringLists(
  before: readonly string[],
  after: readonly string[],
): { added: readonly string[]; removed: readonly string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);

  const added = after.filter((id) => !beforeSet.has(id));
  const removed = before.filter((id) => !afterSet.has(id));

  return { added, removed };
}

export function computeDrift(before: DriftSnapshot, after: DriftSnapshot): DriftReport {
  const hashChanged = before.meta.intelligenceHash !== after.meta.intelligenceHash;

  const patternDiff = diffStringLists(before.patternIds, after.patternIds);
  const insightDiff = diffStringLists(before.insightIds, after.insightIds);

  return {
    hashChanged,
    buildBefore: before.meta.buildNumber,
    buildAfter: after.meta.buildNumber,
    generatedBefore: before.meta.generatedAt,
    generatedAfter: after.meta.generatedAt,
    stats: {
      before: before.meta.stats,
      after: after.meta.stats,
      patternDelta: after.meta.stats.totalPatterns - before.meta.stats.totalPatterns,
      edgeDelta: after.meta.stats.totalEdges - before.meta.stats.totalEdges,
      fileDelta: after.meta.stats.totalFiles - before.meta.stats.totalFiles,
    },
    patterns: {
      added: patternDiff.added,
      removed: patternDiff.removed,
      total: {
        before: before.patternIds.length,
        after: after.patternIds.length,
      },
    },
    insights: {
      added: insightDiff.added,
      removed: insightDiff.removed,
      total: {
        before: before.insightIds.length,
        after: after.insightIds.length,
      },
    },
  };
}

// -----------------------------------------------------------------------------
// Report formatters
// -----------------------------------------------------------------------------

function signedDelta(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `${n}`;
  return "0";
}

export function formatDriftText(report: DriftReport): string {
  const lines: string[] = [];

  lines.push("Context Drift Report");
  lines.push("====================");
  lines.push("");
  lines.push(`Build: #${report.buildBefore} → #${report.buildAfter}`);
  lines.push(`Hash changed: ${report.hashChanged ? "YES" : "no"}`);
  lines.push("");

  // Stats
  lines.push("Stats:");
  lines.push(`  Patterns:  ${report.stats.before.totalPatterns} → ${report.stats.after.totalPatterns} (${signedDelta(report.stats.patternDelta)})`);
  lines.push(`  Edges:     ${report.stats.before.totalEdges} → ${report.stats.after.totalEdges} (${signedDelta(report.stats.edgeDelta)})`);
  lines.push(`  Files:     ${report.stats.before.totalFiles} → ${report.stats.after.totalFiles} (${signedDelta(report.stats.fileDelta)})`);
  lines.push("");

  // Patterns
  if (report.patterns.added.length > 0 || report.patterns.removed.length > 0) {
    lines.push("Pattern changes:");
    for (const id of report.patterns.added) {
      lines.push(`  [+] ${id}`);
    }
    for (const id of report.patterns.removed) {
      lines.push(`  [-] ${id}`);
    }
    lines.push("");
  }

  // Insights
  if (report.insights.added.length > 0 || report.insights.removed.length > 0) {
    lines.push("Insight changes:");
    for (const id of report.insights.added) {
      lines.push(`  [+] ${id}`);
    }
    for (const id of report.insights.removed) {
      lines.push(`  [-] ${id}`);
    }
    lines.push("");
  }

  if (!report.hashChanged) {
    lines.push("No drift detected. Intelligence is up to date.");
  }

  return lines.join("\n");
}

export function formatDriftMarkdown(report: DriftReport): string {
  const lines: string[] = [];

  lines.push("# Context Drift Report");
  lines.push("");
  lines.push(`**Build:** #${report.buildBefore} → #${report.buildAfter}`);
  lines.push(`**Hash changed:** ${report.hashChanged ? "YES" : "no"}`);
  lines.push("");

  // Stats table
  lines.push("## Stats");
  lines.push("");
  lines.push("| Metric | Before | After | Delta |");
  lines.push("|--------|--------|-------|-------|");
  lines.push(`| Patterns | ${report.stats.before.totalPatterns} | ${report.stats.after.totalPatterns} | ${signedDelta(report.stats.patternDelta)} |`);
  lines.push(`| Edges | ${report.stats.before.totalEdges} | ${report.stats.after.totalEdges} | ${signedDelta(report.stats.edgeDelta)} |`);
  lines.push(`| Files | ${report.stats.before.totalFiles} | ${report.stats.after.totalFiles} | ${signedDelta(report.stats.fileDelta)} |`);
  lines.push("");

  if (report.patterns.added.length > 0 || report.patterns.removed.length > 0) {
    lines.push("## Pattern Changes");
    lines.push("");
    for (const id of report.patterns.added) {
      lines.push(`- **+** \`${id}\``);
    }
    for (const id of report.patterns.removed) {
      lines.push(`- **-** \`${id}\``);
    }
    lines.push("");
  }

  if (report.insights.added.length > 0 || report.insights.removed.length > 0) {
    lines.push("## Insight Changes");
    lines.push("");
    for (const id of report.insights.added) {
      lines.push(`- **+** \`${id}\``);
    }
    for (const id of report.insights.removed) {
      lines.push(`- **-** \`${id}\``);
    }
    lines.push("");
  }

  if (!report.hashChanged) {
    lines.push("*No drift detected. Intelligence is up to date.*");
  }

  return lines.join("\n");
}

export function formatDriftJson(report: DriftReport): string {
  return JSON.stringify(report, null, 2);
}
