export type {
  DriftSnapshot,
  DriftReport,
  PatternDiff,
  InsightDiff,
  StatsDiff,
} from "./DriftDetector.js";

export {
  loadSnapshot,
  computeDrift,
  formatDriftText,
  formatDriftMarkdown,
  formatDriftJson,
} from "./DriftDetector.js";

export { compareBranches } from "./BranchDiff.js";
export type { BranchDiffOptions, BranchDiffResult } from "./BranchDiff.js";
