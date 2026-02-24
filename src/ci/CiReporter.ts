import type { DriftReport } from "../drift/DriftDetector.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type CiFailLevel = "error" | "warning" | "info" | "none";

export interface CiReportOptions {
  readonly format: "text" | "md" | "json";
  readonly failOn: CiFailLevel;
}

export interface CiReportResult {
  readonly output: string;
  readonly exitCode: number; // 0 = pass, 1 = fail
  readonly newIssueCount: number;
  readonly resolvedIssueCount: number;
}

interface InsightEntry {
  readonly id: string;
  readonly category: string;
  readonly severity: string;
  readonly title: string;
  readonly description: string;
}

// -----------------------------------------------------------------------------
// Fail-level severity ordering
// -----------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = {
  error: 3,
  warning: 2,
  info: 1,
  none: 0,
};

function severityMeetsThreshold(severity: string, threshold: CiFailLevel): boolean {
  return (SEVERITY_ORDER[severity] ?? 0) >= (SEVERITY_ORDER[threshold] ?? 0);
}

// -----------------------------------------------------------------------------
// Internal format helpers
// -----------------------------------------------------------------------------

function formatCiText(
  drift: DriftReport | null,
  currentInsights: readonly InsightEntry[],
  newInsights: readonly InsightEntry[],
  resolvedInsights: readonly InsightEntry[],
  pass: boolean,
  failReason: string,
): string {
  const lines: string[] = [];

  lines.push("UIQuarter CI Report");
  lines.push("===================");
  lines.push("");

  if (pass) {
    lines.push("Status: PASS");
  } else {
    lines.push(`Status: FAIL (${failReason})`);
  }
  lines.push("");

  if (drift) {
    lines.push("Changes:");
    const pAdded = drift.patterns.added.length;
    const pRemoved = drift.patterns.removed.length;
    lines.push(
      `  Patterns: ${drift.patterns.total.before} -> ${drift.patterns.total.after} (+${pAdded} added, -${pRemoved} removed)`,
    );
    const iAdded = drift.insights.added.length;
    const iRemoved = drift.insights.removed.length;
    lines.push(
      `  Insights: ${drift.insights.total.before} -> ${drift.insights.total.after} (+${iAdded} added, -${iRemoved} removed)`,
    );
    lines.push("");
  } else {
    lines.push(`Current state: ${currentInsights.length} insight(s) detected.`);
    lines.push("");
  }

  if (newInsights.length > 0) {
    lines.push("New Issues:");
    for (const i of newInsights) {
      lines.push(`  [${i.severity.toUpperCase()}] ${i.category}: ${i.title}`);
    }
    lines.push("");
  }

  if (resolvedInsights.length > 0) {
    lines.push("Resolved Issues:");
    for (const i of resolvedInsights) {
      lines.push(`  [${i.severity.toUpperCase()}] ${i.category}: ${i.title}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatCiMarkdown(
  drift: DriftReport | null,
  currentInsights: readonly InsightEntry[],
  newInsights: readonly InsightEntry[],
  resolvedInsights: readonly InsightEntry[],
  pass: boolean,
  failReason: string,
): string {
  const lines: string[] = [];

  lines.push("## UIQuarter CI Report");
  lines.push("");

  if (pass) {
    lines.push("### Status: PASS");
  } else {
    lines.push(`### Status: FAIL (${failReason})`);
  }
  lines.push("");

  if (drift) {
    lines.push("### Changes");
    const pAdded = drift.patterns.added.length;
    const pRemoved = drift.patterns.removed.length;
    lines.push(
      `- Patterns: ${drift.patterns.total.before} → ${drift.patterns.total.after} (+${pAdded} added, -${pRemoved} removed)`,
    );
    const iAdded = drift.insights.added.length;
    const iRemoved = drift.insights.removed.length;
    lines.push(
      `- Insights: ${drift.insights.total.before} → ${drift.insights.total.after} (+${iAdded} added, -${iRemoved} removed)`,
    );
    lines.push("");
  } else {
    lines.push(`Current state: ${currentInsights.length} insight(s) detected.`);
    lines.push("");
  }

  if (newInsights.length > 0) {
    lines.push("### New Issues");
    for (const i of newInsights) {
      lines.push(`- [${i.severity.toUpperCase()}] ${i.category}: ${i.title}`);
    }
    lines.push("");
  }

  if (resolvedInsights.length > 0) {
    lines.push("### Resolved Issues");
    for (const i of resolvedInsights) {
      lines.push(`- [${i.severity.toUpperCase()}] ${i.category}: ${i.title}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatCiJson(
  drift: DriftReport | null,
  currentInsights: readonly InsightEntry[],
  newInsights: readonly InsightEntry[],
  resolvedInsights: readonly InsightEntry[],
  pass: boolean,
  failReason: string,
): string {
  return JSON.stringify(
    {
      status: pass ? "PASS" : "FAIL",
      failReason: pass ? null : failReason,
      drift: drift
        ? {
            patterns: drift.patterns,
            insights: drift.insights,
            stats: drift.stats,
          }
        : null,
      currentInsightCount: currentInsights.length,
      newIssues: newInsights.map((i) => ({
        severity: i.severity,
        category: i.category,
        title: i.title,
      })),
      resolvedIssues: resolvedInsights.map((i) => ({
        severity: i.severity,
        category: i.category,
        title: i.title,
      })),
    },
    null,
    2,
  );
}

// -----------------------------------------------------------------------------
// Main report generator
// -----------------------------------------------------------------------------

export function generateCiReport(
  drift: DriftReport | null,
  currentInsights: readonly InsightEntry[],
  options: CiReportOptions,
): CiReportResult {
  // Build lookup of current insights by ID for matching against drift
  const insightById = new Map<string, InsightEntry>();
  for (const i of currentInsights) {
    insightById.set(i.id, i);
  }

  let newInsights: InsightEntry[] = [];
  let resolvedInsights: InsightEntry[] = [];

  if (drift) {
    // New insights = IDs that appeared in the drift's added list
    newInsights = drift.insights.added
      .map((id) => insightById.get(id))
      .filter((i): i is InsightEntry => i !== undefined);

    // Resolved insights = IDs that were removed (we don't have full data, build stubs)
    resolvedInsights = drift.insights.removed.map((id) => ({
      id,
      category: "unknown",
      severity: "info",
      title: id,
      description: "",
    }));
  }

  // Determine pass/fail
  let pass = true;
  let failReason = "";

  if (drift && options.failOn !== "none") {
    const failingNew = newInsights.filter((i) =>
      severityMeetsThreshold(i.severity, options.failOn),
    );
    if (failingNew.length > 0) {
      pass = false;
      failReason = `${failingNew.length} new issue(s) at or above ${options.failOn} severity`;
    }
  }
  // If drift is null, no baseline to compare — always pass

  // Format output
  let output: string;
  switch (options.format) {
    case "text":
      output = formatCiText(drift, currentInsights, newInsights, resolvedInsights, pass, failReason);
      break;
    case "md":
      output = formatCiMarkdown(drift, currentInsights, newInsights, resolvedInsights, pass, failReason);
      break;
    case "json":
      output = formatCiJson(drift, currentInsights, newInsights, resolvedInsights, pass, failReason);
      break;
  }

  return {
    output,
    exitCode: pass ? 0 : 1,
    newIssueCount: newInsights.length,
    resolvedIssueCount: resolvedInsights.length,
  };
}

// -----------------------------------------------------------------------------
// GitHub Action template
// -----------------------------------------------------------------------------

export function generateGithubActionTemplate(): string {
  return `name: UIQuarter CI

on:
  pull_request:
    branches: [main, master]

jobs:
  uiquarter:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install dependencies
        run: npm ci

      - name: Install UIQuarter
        run: npm install -g uiquarter

      - name: Run UIQuarter analysis
        run: uiquarter init

      - name: Run UIQuarter CI check
        run: |
          uiquarter ci --format md --fail-on error --output uiq-report.md
        continue-on-error: true

      - name: Comment on PR
        if: github.event_name == 'pull_request'
        run: |
          uiquarter ci --format md --pr \${{ github.event.pull_request.number }} --repo \${{ github.repository }} --update

      - name: Check exit code
        run: uiquarter ci --fail-on error
`;
}
