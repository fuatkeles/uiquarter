export { createContext } from "./context.js";
export { FileDiscovery } from "./FileDiscovery.js";
export { AnalyzerOrchestrator } from "./AnalyzerOrchestrator.js";
export { normalizeOutput, DEFAULT_METADATA_KEY_MAP } from "./normalizer.js";
export {
  stableStringify,
  stableReplacer,
  atomicWrite,
  compare,
  sortedRecord,
  computeEmptyHash,
} from "./utils.js";

export type { CoreContext } from "./context.js";
export type { FileDiscoveryOptions } from "./FileDiscovery.js";
export type {
  OrchestratorOptions,
  OrchestratorResult,
  OrchestratorError,
  OrchestratorErrorPhase,
} from "./AnalyzerOrchestrator.js";
export type { NormalizerOptions, MetadataMapping } from "./normalizer.js";
export { CURRENT_SCHEMA_VERSION, checkSchemaVersion, migrateSchema } from "./schemaMigration.js";
export type { MigrationCheckResult } from "./schemaMigration.js";
