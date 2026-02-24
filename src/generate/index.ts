export type {
  GenerateTargetName,
  GeneratedFile,
  GeneratorContext,
  ConventionContext,
  FormatterOptions,
  TargetFormatter,
  TargetConfig,
  GenerateCommandOptions,
} from "./types.js";

export {
  getTargetConfig,
  getAllTargetNames,
  getAllTargetConfigs,
} from "./registry.js";

export {
  buildOverviewSection,
  buildCompactOverviewSection,
  buildConventionsSection,
  buildCompactConventionsSection,
  buildKeyComponentsSection,
  buildHubsOnlySection,
  buildComponentTableSection,
  buildDependencySection,
  buildInsightsSection,
  buildTopInsightsSection,
  buildGuidelinesSection,
  buildDirectiveGuidelinesSection,
  buildInstructionGuidelinesSection,
  composeSectionsWithBudget,
} from "./sections.js";

export { formatClaude } from "./formatters/claude.js";
export { formatCodex } from "./formatters/codex.js";
export { formatCursor } from "./formatters/cursor.js";
export { formatWindsurf } from "./formatters/windsurf.js";
export { formatCline } from "./formatters/cline.js";
export { formatCopilot } from "./formatters/copilot.js";
export { formatAider } from "./formatters/aider.js";
