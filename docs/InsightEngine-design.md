# InsightEngine — Complete Design Specification

## Context

Phase 2 produced 6 production analyzers. Phase 2.5 stabilized the architecture. The IntelligenceIndexer now builds a merged `IntelligenceIndex` containing typed edges, file/type indexes, and graph metrics. This document specifies the InsightEngine — a post-indexing analysis layer that converts the merged index into actionable `Insight[]`.

**Goal:** Extract high-level architectural intelligence from the IntelligenceIndex. Not an Analyzer — operates on the merged cross-analyzer index, not on individual source files.

**Pipeline position:**
```
Files → Discovery → Orchestrator(Analyzers) → Normalizer → Indexer → InsightEngine → Output
                                                              ↑                          ↓
                                                    IntelligenceIndex            Insight[]
```

---

## 1. InsightEngine Class Structure

```typescript
// src/insights/InsightEngine.ts

export class InsightEngine {
  private readonly config: InsightEngineConfig;

  constructor(config?: Partial<InsightEngineConfig>);

  /**
   * Pure function: same index → identical output (byte-level determinism).
   * Does NOT modify the index.
   */
  run(index: IntelligenceIndex): InsightEngineResult;
}

export interface InsightEngineConfig {
  // Hub detection
  readonly hubInDegreeThreshold: number;       // Default: 5
  readonly hubPercentileThreshold: number;     // Default: 0.90 (top 10%)

  // Orphan detection
  readonly orphanExcludeTypes: readonly PatternType[];  // Default: ["page", "layout", "provider"]
  readonly orphanExcludeRoles: readonly string[];       // Default: ["pages", "layouts", "root"]

  // Deep chain
  readonly deepChainThreshold: number;         // Default: 8

  // Mixed styling
  readonly mixedStylingMinTechnologies: number; // Default: 3
  readonly mixedStylingFileThreshold: number;   // Default: 2

  // Architectural smell
  readonly godComponentOutDegree: number;      // Default: 10
  readonly excessivePropCount: number;         // Default: 15
  readonly missingBarrelMinExports: number;    // Default: 3

  // Global
  readonly maxInsightsPerCategory: number;     // Default: 50
}

export interface InsightEngineResult {
  readonly insights: readonly Insight[];
  readonly stats: InsightStats;
  readonly hash: string;           // SHA-256 of stableStringify(insights)
  readonly duration: number;       // Wall-clock ms
}

export interface InsightStats {
  readonly total: number;
  readonly byCategory: Readonly<Record<InsightCategory, number>>;
  readonly bySeverity: Readonly<Record<InsightSeverity, number>>;
  readonly inputPatternCount: number;
  readonly inputEdgeCount: number;
}
```

### Method Decomposition

```typescript
class InsightEngine {
  constructor(config?: Partial<InsightEngineConfig>);

  run(index: IntelligenceIndex): InsightEngineResult;

  // ── Private: category detectors ───────────────────────────────────
  private detectHubComponents(index: IntelligenceIndex): Insight[];
  private detectOrphanComponents(index: IntelligenceIndex): Insight[];
  private detectDependencyCycles(index: IntelligenceIndex): Insight[];
  private detectDeepDependencyChains(index: IntelligenceIndex): Insight[];
  private detectMixedStyling(index: IntelligenceIndex): Insight[];
  private detectArchitecturalSmells(index: IntelligenceIndex): Insight[];

  // ── Private: helpers ──────────────────────────────────────────────
  private buildAdjacencyMaps(edges: readonly DependencyEdge[]): AdjacencyMaps;
  private lookupGraphMetrics(index: IntelligenceIndex): GraphMetricsLookup;
  private lookupStylingProfile(index: IntelligenceIndex): StylingProfileLookup;
  private lookupConventions(index: IntelligenceIndex): ConventionsLookup;
  private lookupDirectoryRole(index: IntelligenceIndex, filePath: string): string | null;
  private isPageOrEntryComponent(pattern: PatternResult, index: IntelligenceIndex): boolean;
  private buildInsightId(category: InsightCategory, discriminator: string): string;
  private computeStats(insights: readonly Insight[]): InsightStats;
}
```

### Internal Helper Types (file-private)

```typescript
interface AdjacencyMaps {
  /** from → [to] for all edge kinds */
  readonly outgoing: ReadonlyMap<PatternId, readonly DependencyEdge[]>;
  /** to → [from] for all edge kinds */
  readonly incoming: ReadonlyMap<PatternId, readonly DependencyEdge[]>;
  /** in-degree per node */
  readonly inDegree: ReadonlyMap<PatternId, number>;
  /** out-degree per node */
  readonly outDegree: ReadonlyMap<PatternId, number>;
  /** Render-only in-degree (subset: kind = "render") */
  readonly renderInDegree: ReadonlyMap<PatternId, number>;
}

interface GraphMetricsLookup {
  readonly available: boolean;
  readonly totalNodes: number;
  readonly totalEdges: number;
  readonly maxDepth: number;
  readonly orphanNodes: readonly PatternId[];
  readonly orphanCount: number;
  readonly cycleCount: number;
  readonly maxCycleLength: number;
  readonly maxInDegree: number;
  readonly maxInDegreeNode: PatternId | null;
  readonly averageOutDegree: number;
  readonly componentCount: number;
}

interface StylingProfileLookup {
  readonly available: boolean;
  readonly primaryApproach: string;
  readonly secondaryApproaches: readonly string[];
  readonly technologyTally: Readonly<Record<string, number>>;
  readonly totalStyleFiles: number;
  readonly totalStyledSourceFiles: number;
  readonly cssModuleFileCount: number;
  readonly tailwindFileCount: number;
  readonly cssInJsFileCount: number;
}

interface ConventionsLookup {
  readonly available: boolean;
  readonly dominantFileNaming: string;
  readonly dominantDirNaming: string;
  readonly testStrategy: string;
  readonly styleStrategy: string;
  readonly barrelCount: number;
  readonly componentDirCount: number;
  readonly totalDirectories: number;
  readonly totalFiles: number;
}
```

---

## 2. Insight Type System

```typescript
// src/types/insight.ts

export type InsightCategory =
  | "hub-component"
  | "orphan-component"
  | "dependency-cycle"
  | "deep-dependency-chain"
  | "mixed-styling"
  | "architectural-smell";

export type InsightSeverity = "info" | "warning" | "error";

export interface Insight {
  /** Deterministic, unique ID. Format: "${category}:${discriminator}" */
  readonly id: string;

  /** The insight category */
  readonly category: InsightCategory;

  /** Severity level */
  readonly severity: InsightSeverity;

  /** Human-readable title (one line, <100 chars) */
  readonly title: string;

  /** Human-readable description with context and actionable guidance */
  readonly description: string;

  /** PatternIds of related patterns in the IntelligenceIndex */
  readonly relatedPatterns: readonly PatternId[];

  /** 0-1 confidence that this insight is correct and actionable */
  readonly confidence: number;

  /** Category-specific structured data */
  readonly metadata: Readonly<Record<string, unknown>>;
}
```

### Insight ID Format

All IDs are deterministic. Format: `${category}:${discriminator}`.

| Category | Discriminator | Example |
|---|---|---|
| `hub-component` | PatternId of the hub | `hub-component:src/Button.tsx:Button:5` |
| `orphan-component` | PatternId of the orphan | `orphan-component:src/OldCard.tsx:OldCard:3` |
| `dependency-cycle` | `cycle-${cycleIndex}` (1-based) | `dependency-cycle:cycle-1` |
| `deep-dependency-chain` | PatternId of deepest leaf | `deep-dependency-chain:src/DeepLeaf.tsx:DeepLeaf:1` |
| `mixed-styling` | `project` or `file:${filePath}` | `mixed-styling:project` |
| `architectural-smell` | `${subType}:${patternId-or-path}` | `architectural-smell:god-component:src/App.tsx:App:1` |

No collision across categories — category prefix ensures uniqueness. Within a category, discriminator is unique because it's derived from unique PatternIds or singleton labels.

---

## 3. Insight Categories — Detailed Specification

### 3.1 hub-component

**Definition:** A component rendered or used by an unusually high number of other components. Indicates high coupling — changes to this component have wide blast radius.

**Trigger:** A component pattern has render-in-degree (edges with `kind = "render"` pointing TO it) >= `hubInDegreeThreshold` (default 5) OR is in the top `(1 - hubPercentileThreshold)` of render-in-degree distribution (default top 10%).

**Severity:**
- `inDegree >= 3 * threshold` → `"error"` (critical coupling)
- `inDegree >= 2 * threshold` → `"warning"` (significant hub)
- otherwise → `"info"` (notable hub)

**Confidence:**
```
renderEdges = incoming edges with kind = "render" pointing to this pattern
avgEdgeConfidence = mean(renderEdges.map(e => confidence from dep pattern metadata))
magnitudeScore = min(1.0, renderInDegree / (3 * threshold))
confidence = (magnitudeScore * 0.6) + (avgEdgeConfidence * 0.4)
```

If `avgEdgeConfidence` cannot be determined (no metadata), use `0.7` as default.

**Title:** `"Hub component: ${name} (${renderInDegree} dependents)"`

**Description:** `"${name} in ${filePath} is rendered by ${renderInDegree} other components. Changes to this component affect ${renderInDegree} dependents. Consider if this coupling is intentional or if the component should be split."`

**relatedPatterns:** `[hubPatternId, ...sortedDependentPatternIds]` (hub first, then all patterns that render it, sorted by PatternId).

**Metadata:**
```typescript
{
  renderInDegree: number,           // Render-only in-degree
  totalInDegree: number,            // All edge kinds
  dependents: PatternId[],          // Sorted PatternIds of components that render this
  dependentNames: string[],         // Sorted names of dependents
  dependentFiles: string[],         // Sorted unique file paths of dependents
  hookUsageInDegree: number,        // Hooks using this (if it's a hook)
  percentile: number,               // 0-1 position in in-degree distribution
}
```

### 3.2 orphan-component

**Definition:** A component with zero render-type incoming edges — never rendered by another component. Potentially dead code, an undiscovered entry point, or a library-exported component.

**Detection source:** Cross-reference `index.typeIndex.get("component")` and `index.typeIndex.get("hook")` with the render-in-degree map.

**Exclusions (NOT flagged as orphan):**
1. Patterns with `type = "page"`, `"layout"`, or `"provider"` — these are entry points by design
2. Patterns whose `filePath` is in a directory with `role = "pages"` or `role = "layouts"` (via FileStructureAnalyzer directory patterns)
3. Patterns that are `isDefaultExport: true` in the root `src/index.*` or `src/App.*` files
4. Patterns exported from barrel files (check if any import pattern's `metadata.isBarrel === true` includes this file)

**Severity:**
- `"warning"` if the component has outgoing render edges (it renders others but nothing renders it — likely dead)
- `"info"` otherwise (might be externally consumed)

**Confidence:**
```
noRenderEdgesScore = (renderInDegree === 0) ? 1.0 : 0.0
notPageScore = isPageOrEntry ? 0.0 : 1.0
noBarrelExposure = isExportedFromBarrel ? 0.3 : 1.0
hasImportEdges = (importInDegree > 0) ? 0.5 : 1.0

confidence = (noRenderEdgesScore * 0.3) +
             (notPageScore * 0.3) +
             (noBarrelExposure * 0.2) +
             (hasImportEdges * 0.2)
```

**Title:** `"Orphan component: ${name}"`

**Description:** `"${name} in ${filePath} is never rendered by another component. ${outDegree > 0 ? 'It renders ' + outDegree + ' other components, suggesting it may be dead code.' : 'It may be an entry point, library export, or unused component.'}"`

**relatedPatterns:** `[orphanPatternId]`

**Metadata:**
```typescript
{
  outDegree: number,                // Outgoing render edges
  importInDegree: number,           // Import-type incoming edges
  isExported: boolean,              // isDefaultExport || isNamedExport
  isInBarrel: boolean,              // Exported from a barrel file
  directoryRole: string | null,     // Role of containing directory
  exclusionReason: string | null,   // Why it was NOT excluded (always null — excluded ones don't appear)
}
```

### 3.3 dependency-cycle

**Definition:** A circular dependency chain where A depends on B depends on ... depends on A.

**Detection:** Read existing `.:dependency-cycle:N` patterns from the index. The DependencyAnalyzer already detected cycles via Tarjan's SCC algorithm. InsightEngine does NOT re-run cycle detection — it transforms the existing cycle patterns into Insight format.

**Algorithm:**
```
for each entry in index.entries:
  if entry.name === "dependency-cycle":
    extract cycleIndex, members, memberNames, length, edgeKinds, severity from metadata
    build Insight
```

**Severity:**
- `"error"` if `length > 5` (large cycle — hard to break)
- `"warning"` if `length > 2` (moderate cycle)
- `"info"` if `length === 2` (simple bidirectional dependency)

**Confidence:** `1.0` — Tarjan's SCC is deterministic and exact.

**Title:** `"Dependency cycle: ${memberNames.join(' → ')} → ${memberNames[0]}" ` (truncated to first 3 members + "..." if > 3)

**Description:** `"Circular dependency of ${length} components: ${memberNames.join(' → ')} → ${memberNames[0]}. Edge kinds: ${uniqueEdgeKinds.join(', ')}. Circular dependencies make refactoring difficult and can cause initialization issues."`

**relatedPatterns:** `[...members]` (sorted)

**Metadata:**
```typescript
{
  cycleIndex: number,
  length: number,
  members: PatternId[],             // Sorted cycle member IDs
  memberNames: string[],            // Ordered names forming the cycle ring
  memberFiles: string[],            // Ordered file paths
  edgeKinds: string[],              // Edge kinds around the ring
  uniqueEdgeKinds: string[],        // Sorted unique edge kinds
  sourceCyclePatternId: PatternId,  // ID of the DependencyAnalyzer cycle pattern
}
```

### 3.4 deep-dependency-chain

**Definition:** An excessively long chain of dependencies from a root node to a leaf node. Indicates tight coupling and fragile architecture — a change at the leaf propagates through many layers.

**Algorithm:**
```
DETECT_DEEP_CHAINS(index, threshold):

  Step 1: Build adjacency map from index.edges (all kinds)

  Step 2: Identify root nodes (in-degree = 0 among component/hook/provider/hoc types)

  Step 3: BFS from each root
    - Track visited set (avoid infinite loops from cycles)
    - Track parent chain per node
    - If depth > threshold: record the chain (root → ... → current node)

  Step 4: For each leaf (node where BFS stops due to no unvisited neighbors):
    - If depth > threshold: emit insight

  Step 5: Deduplicate — if multiple chains share the same leaf, keep only the longest

  Step 6: Sort by depth descending, take top maxInsightsPerCategory
```

**Edge kinds considered:** `"render"`, `"hook-usage"`, `"hoc-wrapping"`, `"provider"` — NOT `"import"` (import edges are too granular, every file imports things).

**Threshold:** Default 8 levels deep.

**Severity:**
- `"error"` if `depth > 2 * threshold` (extremely deep)
- `"warning"` if `depth > threshold` (notably deep)

**Confidence:**
```
depthRatio = min(1.0, (depth - threshold) / threshold + 0.5)
chainEdgeConfidence = product(edge confidences along chain) ^ (1/length)  // geometric mean
confidence = (depthRatio * 0.6) + (chainEdgeConfidence * 0.4)
```

If edge confidence is not available in metadata, use `0.8` as default per edge.

**Title:** `"Deep dependency chain: ${depth} levels (${rootName} → ... → ${leafName})"`

**Description:** `"Dependency chain of ${depth} levels from ${rootName} (${rootFile}) to ${leafName} (${leafFile}). This exceeds the threshold of ${threshold}. Deep chains increase coupling and make changes risky. Consider introducing abstraction boundaries."`

**relatedPatterns:** `[...chainPatternIds]` (ordered from root to leaf)

**Metadata:**
```typescript
{
  depth: number,
  chain: PatternId[],               // Ordered root → leaf
  chainNames: string[],             // Ordered names
  chainFiles: string[],             // Ordered file paths
  rootPatternId: PatternId,
  leafPatternId: PatternId,
  edgeKinds: string[],              // Edge kind at each step
  threshold: number,                // Config threshold used
}
```

### 3.5 mixed-styling

**Definition:** The project (or a specific file) uses multiple incompatible styling approaches simultaneously. Makes maintenance harder and increases bundle size.

**Two sub-types:**

#### 3.5a Project-Level Mixed Styling

**Source:** `.:styling-profile:1` pattern.

**Algorithm:**
```
profile = index.entries.get(".:styling-profile:1")
tally = profile.metadata.technologyTally
activeTechnologies = entries in tally where count > 0
                     AND technology !== "plain-css"
                     AND technology !== "mixed"

if activeTechnologies.length >= mixedStylingMinTechnologies (default 3):
  emit project-level insight

ALSO: if both utility-first (tailwind) AND CSS-in-JS (styled-components, emotion, vanilla-extract)
      have nonzero tallies → emit even if < 3 total technologies (paradigm clash)
```

**Severity:**
- `"warning"` for 3+ technologies
- `"error"` for paradigm clash (utility-first + CSS-in-JS)

**Confidence:**
```
techCount = activeTechnologies.length
totalFiles = totalStyleFiles + totalStyledSourceFiles
consistency = max(tally.values()) / sum(tally.values())  // how dominant is the primary
confidence = min(1.0, techCount / 5) * (1.0 - consistency * 0.5)
```

Higher confidence when more technologies compete, lower when one clearly dominates.

**Title:** `"Mixed styling: ${techCount} approaches across project"`

**Description:** `"Project uses ${activeTechnologies.join(', ')}. Primary approach: ${primaryApproach} (${primaryCount} files). Consolidating to fewer styling approaches reduces bundle size and cognitive overhead."`

**relatedPatterns:** `[".:styling-profile:1" as PatternId]`

**Metadata:**
```typescript
{
  activeTechnologies: string[],     // Sorted active technology names
  technologyTally: Record<string, number>,
  primaryApproach: string,
  totalFiles: number,
  isParadigmClash: boolean,         // Utility-first AND CSS-in-JS together
}
```

#### 3.5b File-Level Mixed Styling

**Source:** Per-file `${filePath}:styling:1` patterns.

**Algorithm:**
```
for each pattern where name === "styling":
  count active boolean flags:
    tailwind, styled-components, emotion, vanilla-extract, css-modules, inline-styles
  if activeCount >= mixedStylingFileThreshold (default 2):
    emit file-level insight
```

**Severity:** `"info"` for 2 approaches, `"warning"` for 3+.

**Confidence:** `min(1.0, activeCount / 4)`

**Title:** `"Mixed styling in ${fileName}: ${activeApproaches.join(', ')}"`

**Description:** `"${filePath} uses ${activeCount} styling approaches: ${activeApproaches.join(', ')}. Consider consolidating to a single approach per file."`

**relatedPatterns:** `[stylingPatternId]`

**Metadata:**
```typescript
{
  filePath: string,
  activeApproaches: string[],       // Sorted active approach names
  approachCount: number,
}
```

### 3.6 architectural-smell

**Definition:** Structural anti-patterns detected by cross-referencing the component graph, directory structure, and naming conventions. Multiple sub-types.

#### Sub-type: god-component

**Trigger:** Component with `outDegree > godComponentOutDegree` (default 10) for render-kind edges.

**Source:** Render-out-degree map + component patterns.

**Severity:**
- `"error"` if `outDegree > 2 * threshold`
- `"warning"` otherwise

**Confidence:** `min(1.0, outDegree / (2 * threshold))`

**Title:** `"God component: ${name} renders ${outDegree} components"`

**Description:** `"${name} in ${filePath} directly renders ${outDegree} child components (threshold: ${threshold}). This component likely has too many responsibilities. Consider splitting into smaller, focused components."`

**relatedPatterns:** `[godPatternId, ...childPatternIds]` (sorted)

**Metadata:**
```typescript
{
  subType: "god-component",
  renderOutDegree: number,
  childComponents: string[],        // Sorted names
  childFiles: string[],             // Sorted unique file paths
  threshold: number,
}
```

#### Sub-type: wrong-directory

**Trigger:** A component (type `"component"`) residing in a directory classified as `"utils"`, `"helpers"`, `"lib"`, `"services"`, `"api"`, `"constants"`, `"types"`, or `"models"`. Or a utility (type `"utility"`) in a `"components"` directory.

**Source:** Cross-reference `typeIndex.get("component")` with directory patterns.

**Algorithm:**
```
for each component pattern:
  dirPath = dirname(pattern.filePath)
  dirPattern = index.entries.get("${dirPath}:directory:1")
  if dirPattern.metadata.role in ["utils", "lib", "services", "api", "constants", "types", "models"]:
    emit wrong-directory insight (component in non-component dir)

for each utility pattern (excluding module, stylesheet, styling, directory, conventions, dependency-graph, dependency-cycle):
  dirPath = dirname(pattern.filePath)
  dirPattern = index.entries.get("${dirPath}:directory:1")
  if dirPattern.metadata.role === "components":
    emit wrong-directory insight (utility in component dir)
```

**Severity:** `"info"`

**Confidence:**
```
directoryRoleScore = dirPattern.metadata.roleScore
confidence = directoryRoleScore * 0.8  // Scale by how confident we are about the directory's role
```

**Title:** `"Misplaced ${patternType}: ${name} in ${dirRole}/ directory"`

**Description:** `"${name} (${patternType}) is in ${dirPath} which is classified as '${dirRole}'. Consider moving it to a more appropriate directory."`

**relatedPatterns:** `[patternId, dirPatternId]`

**Metadata:**
```typescript
{
  subType: "wrong-directory",
  patternType: PatternType,
  directoryRole: string,
  directoryRoleScore: number,
  suggestedRole: string,            // Where it should be: "components" or "utils"/"lib"
}
```

#### Sub-type: excessive-props

**Trigger:** Component pattern with `metadata.propCount > excessivePropCount` (default 15).

**Source:** Component patterns with `metadata.propCount`.

**Severity:** `"warning"`

**Confidence:** `min(1.0, propCount / (2 * threshold))`

**Title:** `"Excessive props: ${name} has ${propCount} props"`

**Description:** `"${name} in ${filePath} accepts ${propCount} props (${requiredCount} required). Components with many props are hard to use and test. Consider grouping related props into objects, using context, or splitting the component."`

**relatedPatterns:** `[componentPatternId]`

**Metadata:**
```typescript
{
  subType: "excessive-props",
  propCount: number,
  requiredPropCount: number,
  threshold: number,
}
```

#### Sub-type: inconsistent-naming

**Trigger:** A directory where the naming convention doesn't match the project-wide dominant convention, AND the directory has >= 3 source files.

**Source:** Cross-reference directory patterns' `metadata.namingConvention` with conventions pattern's `metadata.dominantFileNaming`.

**Algorithm:**
```
conventions = index.entries.get(".:conventions:1")
dominant = conventions.metadata.dominantFileNaming

for each directory pattern:
  if dir.metadata.namingConvention !== dominant
     AND dir.metadata.namingConvention !== "unknown"
     AND dir.metadata.fileCount >= 3:
    emit inconsistent-naming insight
```

**Severity:** `"info"`

**Confidence:**
```
conventionsConfidence = conventions.confidence.value
confidence = conventionsConfidence * 0.6 + (fileCount >= 5 ? 0.4 : 0.2)
```

**Title:** `"Inconsistent naming in ${dirPath}: ${actual} (project uses ${dominant})"`

**Description:** `"Files in ${dirPath} use ${actual} naming but the project convention is ${dominant}. Consistent naming improves discoverability and reduces cognitive load."`

**relatedPatterns:** `[dirPatternId, ".:conventions:1"]`

**Metadata:**
```typescript
{
  subType: "inconsistent-naming",
  directoryPath: string,
  actualConvention: string,
  projectConvention: string,
  fileCount: number,
}
```

#### Sub-type: missing-barrel

**Trigger:** A directory classified as `"components"` or `"hooks"` that has >= `missingBarrelMinExports` (default 3) exported source files but `metadata.hasBarrel === false`.

**Source:** Directory patterns.

**Algorithm:**
```
for each directory pattern:
  if dir.metadata.role in ["components", "hooks"]
     AND dir.metadata.fileCount >= missingBarrelMinExports
     AND dir.metadata.hasBarrel === false:
    emit missing-barrel insight
```

**Severity:** `"info"`

**Confidence:** `0.6 * dirPattern.metadata.roleScore`

**Title:** `"Missing barrel export in ${dirPath} (${fileCount} files)"`

**Description:** `"${dirPath} (role: ${role}) has ${fileCount} files but no index.ts barrel export. Barrel files simplify imports and provide a stable public API."`

**relatedPatterns:** `[dirPatternId]`

**Metadata:**
```typescript
{
  subType: "missing-barrel",
  directoryPath: string,
  directoryRole: string,
  fileCount: number,
}
```

---

## 4. Algorithms

### 4.1 Hub Detection Algorithm

```
DETECT_HUBS(index, config):

  Step 1: Build render-in-degree map
    renderInDegree = new Map<PatternId, number>
    renderIncoming = new Map<PatternId, DependencyEdge[]>
    for each edge in index.edges where edge.kind === "render":
      increment renderInDegree[edge.to]
      append edge to renderIncoming[edge.to]

  Step 2: Compute percentile threshold
    allDegrees = sorted list of all renderInDegree values (ascending)
    if allDegrees.length === 0: return []
    percentileIdx = floor(allDegrees.length * config.hubPercentileThreshold)
    percentileValue = allDegrees[percentileIdx] ?? allDegrees[allDegrees.length - 1]
    effectiveThreshold = max(config.hubInDegreeThreshold, percentileValue)

  Step 3: Identify hubs
    hubs = []
    for each [patternId, degree] in renderInDegree (sorted by patternId):
      if degree >= effectiveThreshold:
        pattern = index.entries.get(patternId)
        if pattern is undefined: continue  // orphaned edge target
        if pattern.type not in ["component", "hook", "hoc", "provider"]: continue
        hubs.push({ patternId, pattern, degree, edges: renderIncoming[patternId] })

  Step 4: Compute confidence per hub
    for each hub:
      avgEdgeConf = mean(getEdgeConfidences(hub.edges, index))
      magnitudeScore = min(1.0, hub.degree / (3 * effectiveThreshold))
      confidence = magnitudeScore * 0.6 + avgEdgeConf * 0.4

  Step 5: Assign severity
    for each hub:
      if degree >= 3 * effectiveThreshold: severity = "error"
      else if degree >= 2 * effectiveThreshold: severity = "warning"
      else: severity = "info"

  Step 6: Build Insight objects (sorted by id)

  Step 7: Truncate to maxInsightsPerCategory
```

### 4.2 Orphan Detection Algorithm

```
DETECT_ORPHANS(index, config):

  Step 1: Collect all component-like patterns
    candidates = []
    for type in ["component", "hook", "hoc"]:
      for patternId in (index.typeIndex.get(type) ?? []):
        candidates.push(patternId)

  Step 2: Build render-in-degree map (reuse from hub detection if cached)
    Same as hub detection Step 1

  Step 3: Build import-in-degree map
    importInDegree = new Map<PatternId, number>
    for each edge in index.edges where edge.kind === "import":
      increment importInDegree[edge.to]

  Step 4: Filter candidates
    orphans = []
    for each patternId in candidates (sorted):
      pattern = index.entries.get(patternId)
      if renderInDegree[patternId] > 0: continue  // Not orphan — something renders it

      // Exclusions
      if pattern.type in config.orphanExcludeTypes: continue
      if isPageOrEntryComponent(pattern, index): continue

      orphans.push({ patternId, pattern })

  Step 5: Determine if page/entry (isPageOrEntryComponent)
    - Check directory role via fileIndex → directory pattern
    - Check if file matches App.*, main.*, index.* at root level
    - Check if pattern is exported from a barrel file

  Step 6: Compute confidence (see Section 3.2 formula)

  Step 7: Build Insight objects (sorted by id)

  Step 8: Truncate to maxInsightsPerCategory
```

### 4.3 Cycle Detection (reuse dependency index)

```
DETECT_CYCLES(index):

  Step 1: Collect cycle patterns from index
    cyclePatterns = []
    for each [id, pattern] of index.entries:
      if pattern.name === "dependency-cycle":
        cyclePatterns.push(pattern)

  Step 2: Sort by cycleIndex from metadata (deterministic)
    cyclePatterns.sort((a, b) => a.metadata.cycleIndex - b.metadata.cycleIndex)

  Step 3: For each cycle pattern, build Insight
    - Extract: members, memberNames, length, edgeKinds from metadata
    - Resolve member file paths from index.entries
    - Assign severity based on length
    - confidence = 1.0

  Step 4: Truncate to maxInsightsPerCategory
```

No re-computation of SCCs — DependencyAnalyzer already did it. InsightEngine simply transforms the existing data.

### 4.4 Deep Chain Detection

```
DETECT_DEEP_CHAINS(index, config):

  Step 1: Build adjacency from semantic edges only
    adjacency = new Map<PatternId, PatternId[]>
    for each edge in index.edges:
      if edge.kind in ["render", "hook-usage", "hoc-wrapping", "provider"]:
        append edge.to to adjacency[edge.from]

  Step 2: Identify root nodes (semantic in-degree = 0)
    semanticInDegree = new Map<PatternId, number>
    for each edge in index.edges:
      if edge.kind in ["render", "hook-usage", "hoc-wrapping", "provider"]:
        increment semanticInDegree[edge.to]

    roots = []
    for each [id, pattern] of index.entries:
      if pattern.type in ["component", "hook", "hoc", "provider"]:
        if (semanticInDegree.get(id) ?? 0) === 0:
          roots.push(id)
    roots.sort()

  Step 3: BFS tracking longest path to each reachable node
    depth = new Map<PatternId, number>       // max depth at which node is reached
    parent = new Map<PatternId, PatternId>   // parent on the longest path
    visited = new Set<PatternId>

    for each root in roots:
      queue = [{ id: root, d: 0 }]
      visited.add(root)
      depth.set(root, 0)

      while queue is not empty:
        { id, d } = queue.shift()
        for each neighbor in adjacency[id]:
          newDepth = d + 1
          if !visited.has(neighbor):
            visited.add(neighbor)
            depth.set(neighbor, newDepth)
            parent.set(neighbor, id)
            queue.push({ id: neighbor, d: newDepth })
          else if newDepth > depth.get(neighbor):
            // Found a longer path (cycle-free because we track visited by node, not by path)
            // BFS doesn't revisit, so this branch won't execute in standard BFS.
            // For simplicity, we use single-visit BFS — the first path found IS the shortest,
            // but we want the LONGEST. Use DFS with memoization instead.

  REVISED Step 3: DFS with memoization (DAG-aware)
    memo = new Map<PatternId, number>       // longest path FROM this node to any leaf
    pathTo = new Map<PatternId, PatternId>  // next node on longest path

    function longestFrom(id: PatternId, visiting: Set<PatternId>): number
      if memo.has(id): return memo.get(id)
      if visiting.has(id): return 0  // cycle — don't recurse
      visiting.add(id)

      maxChild = 0
      bestNext = null
      for each neighbor in (adjacency.get(id) ?? []):
        childDepth = longestFrom(neighbor, visiting) + 1
        if childDepth > maxChild:
          maxChild = childDepth
          bestNext = neighbor

      visiting.delete(id)
      memo.set(id, maxChild)
      if bestNext !== null: pathTo.set(id, bestNext)
      return maxChild

    for each root in roots:
      longestFrom(root, new Set())

  Step 4: Collect chains exceeding threshold
    chains = []
    for each root in roots:
      depth = memo.get(root) ?? 0
      if depth > config.deepChainThreshold:
        chain = reconstructChain(root, pathTo)
        chains.push({ root, chain, depth })

  Step 5: Deduplicate by leaf
    // If multiple roots reach the same leaf, keep the longest chain only
    byLeaf = new Map<PatternId, chain>
    for each chain:
      leaf = chain[chain.length - 1]
      if !byLeaf.has(leaf) OR chain.depth > byLeaf.get(leaf).depth:
        byLeaf.set(leaf, chain)

  Step 6: Sort by depth descending, then by leaf PatternId ascending

  Step 7: Truncate to maxInsightsPerCategory

  Step 8: Build Insight objects
```

### 4.5 Styling System Analysis

```
DETECT_MIXED_STYLING(index, config):

  ── Project Level ──

  Step 1: Look up styling profile
    profile = index.entries.get(".:styling-profile:1")
    if profile is undefined: return []

  Step 2: Extract technology tally
    tally = profile.metadata.technologyTally
    active = entries where count > 0
             AND key not in ["plain-css", "mixed"]

  Step 3: Check paradigm clash
    hasUtilityFirst = tally["tailwind"] > 0
    hasCssInJs = tally["styled-components"] > 0 OR
                 tally["emotion"] > 0 OR
                 tally["vanilla-extract"] > 0
    isParadigmClash = hasUtilityFirst AND hasCssInJs

  Step 4: Emit project insight if active.length >= minTechnologies OR isParadigmClash

  ── File Level ──

  Step 5: Scan per-file styling patterns
    for each [id, pattern] in index.entries:
      if pattern.name !== "styling": continue
      booleanFlags = ["tailwind", "styled-components", "emotion",
                      "vanilla-extract", "css-modules", "inline-styles"]
      active = flags where pattern.metadata[flag] === true
      if active.length >= config.mixedStylingFileThreshold:
        emit file-level insight

  Step 6: Sort all insights by id, truncate
```

### 4.6 Architecture Violation Detection

```
DETECT_ARCH_SMELLS(index, config):

  insights = []

  ── god-component ──
  Step 1: Build render-out-degree map
    for each edge where kind === "render":
      increment outDegree[edge.from]

  Step 2: For each component with outDegree > config.godComponentOutDegree:
    emit god-component insight

  ── wrong-directory ──
  Step 3: Build directory role lookup
    dirRoles = new Map<string, { role, roleScore }>
    for each pattern where name === "directory":
      dirRoles.set(pattern.filePath, pattern.metadata)

  Step 4: Check components in non-component directories
    nonComponentRoles = ["utils", "lib", "services", "api", "constants", "types", "models"]
    for each component pattern:
      dirPath = dirname(pattern.filePath)
      dirMeta = dirRoles.get(dirPath)
      if dirMeta?.role in nonComponentRoles:
        emit wrong-directory insight

  Step 5: Check utilities in component directories
    (only "real" utility patterns — exclude infrastructure patterns
     where name in ["module", "stylesheet", "styling", "directory",
                    "conventions", "dependency-graph", "dependency-cycle",
                    "styling-profile"])
    for each utility with meaningful name:
      dirPath = dirname(pattern.filePath)
      dirMeta = dirRoles.get(dirPath)
      if dirMeta?.role === "components":
        emit wrong-directory insight

  ── excessive-props ──
  Step 6: Check component patterns
    for each component pattern where metadata.propCount exists:
      if metadata.propCount > config.excessivePropCount:
        emit excessive-props insight

  ── inconsistent-naming ──
  Step 7: Compare directory naming vs project convention
    conventions = index.entries.get(".:conventions:1")
    if conventions exists:
      dominant = conventions.metadata.dominantFileNaming
      for each directory pattern (excluding root):
        if dir.metadata.namingConvention !== dominant
           AND dir.metadata.namingConvention !== "unknown"
           AND dir.metadata.fileCount >= 3:
          emit inconsistent-naming insight

  ── missing-barrel ──
  Step 8: Check directories without barrel files
    for each directory pattern:
      if dir.metadata.role in ["components", "hooks"]
         AND dir.metadata.fileCount >= config.missingBarrelMinExports
         AND dir.metadata.hasBarrel === false:
        emit missing-barrel insight

  Step 9: Sort all insights by id, truncate per sub-type
```

---

## 5. Output Schema

### InsightEngineResult (complete)

```typescript
{
  insights: [
    {
      id: "hub-component:src/Button.tsx:Button:5",
      category: "hub-component",
      severity: "warning",
      title: "Hub component: Button (12 dependents)",
      description: "Button in src/Button.tsx is rendered by 12 other components. Changes to this component affect 12 dependents. Consider if this coupling is intentional or if the component should be split.",
      relatedPatterns: [
        "src/Button.tsx:Button:5",   // the hub
        "src/App.tsx:App:1",         // dependent
        "src/Card.tsx:Card:3",       // dependent
        // ... sorted
      ],
      confidence: 0.82,
      metadata: {
        renderInDegree: 12,
        totalInDegree: 14,
        dependents: ["src/App.tsx:App:1", "src/Card.tsx:Card:3", ...],
        dependentNames: ["App", "Card", ...],
        dependentFiles: ["src/App.tsx", "src/Card.tsx", ...],
        hookUsageInDegree: 2,
        percentile: 0.95,
      }
    },
    // ...
  ],
  stats: {
    total: 17,
    byCategory: {
      "hub-component": 3,
      "orphan-component": 5,
      "dependency-cycle": 1,
      "deep-dependency-chain": 2,
      "mixed-styling": 1,
      "architectural-smell": 5,
    },
    bySeverity: {
      info: 8,
      warning: 7,
      error: 2,
    },
    inputPatternCount: 156,
    inputEdgeCount: 89,
  },
  hash: "a1b2c3...",   // SHA-256 of stableStringify(insights)
  duration: 42,
}
```

### Insight Output Persistence

The InsightEngine result is written to `.uiq/insights.json`:

```typescript
{
  generatedAt: string,           // ISO timestamp
  engineVersion: string,         // "1.0.0"
  buildNumber: number,           // From IntelligenceIndex
  compositeHash: string,         // From IntelligenceIndex
  insightHash: string,           // SHA-256 of stableStringify(insights)
  stats: InsightStats,
  insights: Insight[],           // Full array
}
```

Written via `atomicWrite` (from utils.ts) for crash safety.

---

## 6. Deterministic Output Guarantees

### Invariant: Same IntelligenceIndex → byte-identical InsightEngineResult

**Ordering guarantees:**
1. Insights are sorted by `id` (lexicographic, locale-independent via `compare`)
2. `relatedPatterns` arrays are sorted by PatternId within each insight
3. `metadata` object keys are sorted (via `stableStringify`)
4. Array-valued metadata fields (e.g., `dependents`, `memberNames`) are sorted unless order is semantically significant (e.g., `chain` which is root→leaf order, `memberNames` which is cycle ring order)
5. `stats.byCategory` keys are sorted alphabetically
6. `stats.bySeverity` keys are sorted alphabetically

**Hash computation:**
```
result.hash = SHA-256(stableStringify(insights))
```

Where `stableStringify` is the existing utility from `src/core/utils.ts` (deterministic key ordering, 2-space indent, trailing newline).

**Sources of non-determinism eliminated:**
- No `Date.now()` in insight content (only in `duration` and file-level `generatedAt`, excluded from hash)
- No `Math.random()` anywhere
- All iterations use sorted collections
- Floating-point confidence scores are rounded to 3 decimal places: `Math.round(v * 1000) / 1000`

**Verification:** In debug mode, the engine can be run twice with the same input and hashes compared.

---

## 7. PatternId References Usage

### How InsightEngine Reads Patterns

All data comes from the `IntelligenceIndex` passed to `run()`. No filesystem access, no re-parsing.

**Singleton pattern lookups (by well-known ID):**
```typescript
const graphMetrics = index.entries.get(".:dependency-graph:1" as PatternId);
const stylingProfile = index.entries.get(".:styling-profile:1" as PatternId);
const conventions = index.entries.get(".:conventions:1" as PatternId);
```

**Cycle pattern iteration:**
```typescript
for (const [id, pattern] of index.entries) {
  if (pattern.name === "dependency-cycle") { ... }
}
```

**Type-based queries:**
```typescript
const componentIds = index.typeIndex.get("component") ?? [];
const hookIds = index.typeIndex.get("hook") ?? [];
```

**Directory role lookup for a file:**
```typescript
function lookupDirectoryRole(index: IntelligenceIndex, filePath: string): string | null {
  const dirPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ".";
  const dirPatternId = `${dirPath}:directory:1` as PatternId;
  const dirPattern = index.entries.get(dirPatternId);
  return dirPattern?.metadata?.role as string ?? null;
}
```

**Edge confidence lookup:**

DependencyAnalyzer stores edge confidences in the `:dep:1` pattern metadata. To look up the confidence for an edge `{ from, to, kind }`:
```typescript
const depPatternId = findDepPattern(from, index);   // "${filePath}:${name}:dep:1"
const depPattern = index.entries.get(depPatternId);
const edgeMeta = depPattern?.metadata?.edges as Array<{ target: string; confidence: number }>;
const match = edgeMeta?.find(e => e.target === to);
const confidence = match?.confidence ?? 0.8;  // fallback
```

**Finding the `:dep:1` pattern for a component pattern:**

The dep pattern's `metadata.sourcePatternId` equals the component pattern's `id`. Build a reverse lookup:
```typescript
const depBySource = new Map<PatternId, PatternResult>();
for (const [id, pattern] of index.entries) {
  if (id.endsWith(":dep:1") && typeof pattern.metadata.sourcePatternId === "string") {
    depBySource.set(pattern.metadata.sourcePatternId as PatternId, pattern);
  }
}
```

### How InsightEngine References Patterns in Output

Every `Insight.relatedPatterns` contains valid PatternIds that exist in `index.entries`. The engine MUST verify existence before including a PatternId:
```typescript
if (index.entries.has(patternId)) {
  relatedPatterns.push(patternId);
}
```

This protects against orphaned edge targets or stale references.

---

## 8. Integration with IntelligenceIndexer Output

### Pipeline Integration

```typescript
// In src/cli/init.ts (or new src/cli/analyze.ts)

// After: const index = await indexer.buildAndWrite(normalized);
// Add:
import { InsightEngine } from "../insights/InsightEngine.js";

const engine = new InsightEngine();
const insightResult = engine.run(index);

// Write insights to .uiq/insights.json
await atomicWrite(
  join(rootPath, ".uiq/insights.json"),
  stableStringify({
    generatedAt: new Date().toISOString(),
    engineVersion: "1.0.0",
    buildNumber: index.buildNumber,
    compositeHash: index.compositeHash,
    insightHash: insightResult.hash,
    stats: insightResult.stats,
    insights: insightResult.insights,
  }),
);
```

### File Organization

| File | Action |
|---|---|
| `src/insights/InsightEngine.ts` | **CREATE** — full implementation |
| `src/types/insight.ts` | **CREATE** — Insight, InsightCategory, InsightSeverity, InsightEngineResult, InsightStats |
| `src/types/index.ts` | **MODIFY** — add insight type exports |
| `src/index.ts` | **MODIFY** — add InsightEngine export |
| `src/cli/init.ts` | **MODIFY** — add insight generation step after indexer |
| `test/InsightEngine.test.ts` | **CREATE** — comprehensive tests |
| `docs/analyzer-contracts.md` | **MODIFY** — add InsightEngine section |

### Dependencies Used

From `src/core/utils.ts`: `compare`, `stableStringify`, `atomicWrite`
From `node:crypto`: `createHash` (for hash computation)
From `src/types/`: `PatternId`, `PatternResult`, `PatternType`, `IntelligenceIndex`, `DependencyEdge`

No filesystem I/O in the engine itself — it's a pure computation over the index. Only the CLI integration does file writes.

### Export Surface

```typescript
// src/insights/InsightEngine.ts
export { InsightEngine };
export type { InsightEngineConfig, InsightEngineResult };

// src/types/insight.ts
export type { Insight, InsightCategory, InsightSeverity, InsightStats };
```

---

## 9. Performance Complexity

### Time Complexity

| Operation | Complexity | Notes |
|---|---|---|
| Build adjacency maps | O(E) | Single pass over edges |
| Hub detection | O(E + H log H) | E = edge count, H = hub count |
| Orphan detection | O(C + E) | C = component count |
| Cycle detection | O(P) | P = pattern count (linear scan, no SCC re-run) |
| Deep chain detection | O(V + E) | DFS with memoization visits each node once |
| Mixed styling (project) | O(1) | Single pattern lookup |
| Mixed styling (files) | O(S) | S = styling pattern count |
| Architecture smells | O(P + E) | Linear scans over patterns and edges |
| Result sorting | O(I log I) | I = total insight count |
| Hash computation | O(I * M) | M = average metadata size per insight |

**Overall:** O(V + E + P) where V = nodes (components), E = edges, P = total patterns.

For a project with 1000 components, 5000 edges, and 3000 total patterns: well under 100ms.

### Space Complexity

| Structure | Size |
|---|---|
| Adjacency maps | O(E) |
| In/out degree maps | O(V) |
| DFS memoization | O(V) |
| Output insights | O(I * R) where R = avg related patterns |

**Peak memory:** O(E + V + I * R). For typical projects (< 5000 components), this is < 10MB.

### Scaling Limits

| Project Size | Expected Insights | Expected Time |
|---|---|---|
| Small (< 50 files) | 0-10 | < 5ms |
| Medium (50-500 files) | 5-30 | < 20ms |
| Large (500-5000 files) | 10-100 | < 100ms |
| Very large (5000+ files) | 20-200 | < 500ms |

The `maxInsightsPerCategory` cap (default 50) prevents output explosion for very large projects.

---

## 10. Test Plan

### Unit Tests (test/InsightEngine.test.ts)

All tests use manually constructed `IntelligenceIndex` objects — no real files or analyzer runs needed.

#### Infrastructure Tests

1. **Empty index produces empty insights** — 0 entries, 0 edges → `insights.length === 0`, `stats.total === 0`
2. **Deterministic output** — two runs with identical index → identical hashes
3. **Insights sorted by id** — verify lexicographic sort order
4. **relatedPatterns sorted within each insight** — verify sorted PatternIds
5. **Confidence clamped to [0, 1]** — no insight has confidence < 0 or > 1
6. **Confidence rounded to 3 decimals** — verify `Math.round(c * 1000) / 1000 === c`
7. **Hash is 64-char hex** — SHA-256 format
8. **Stats match insights** — `stats.total === insights.length`, per-category counts match
9. **maxInsightsPerCategory respected** — with 100 hubs and cap of 50, verify truncation
10. **Custom config overrides** — non-default thresholds are respected

#### Hub Component Tests

11. **Single hub detected** — component A rendered by 6 others (threshold 5) → 1 hub insight
12. **Below threshold not detected** — component rendered by 4 (threshold 5) → 0 hub insights
13. **Severity escalation** — in-degree = threshold → info, 2x → warning, 3x → error
14. **Percentile threshold used** — when 90th percentile > fixed threshold, use percentile
15. **Non-component types excluded** — utility patterns with high in-degree are NOT hubs
16. **relatedPatterns includes hub + dependents** — verify all PatternIds present and sorted
17. **Metadata has correct fields** — renderInDegree, dependents, percentile all present

#### Orphan Component Tests

18. **Orphan detected** — component with 0 render in-edges → orphan insight
19. **Page components excluded** — pattern.type = "page" not flagged
20. **Layout components excluded** — pattern.type = "layout" not flagged
21. **Provider components excluded** — pattern.type = "provider" not flagged
22. **Components in pages directory excluded** — directory role = "pages" excludes
23. **Barrel-exported components get lower confidence** — not excluded but confidence reduced
24. **Severity: warning if has render out-edges** — orphan that renders others → warning
25. **Severity: info if pure orphan** — no outgoing render edges → info
26. **Components with import-only edges still orphaned** — import edges don't count as "used"

#### Dependency Cycle Tests

27. **Cycle detected from DependencyAnalyzer data** — index with `.:dependency-cycle:1` → 1 insight
28. **Multiple cycles** — 3 cycle patterns → 3 insights with correct cycleIndex
29. **Severity by length** — length 2 → info, length 4 → warning, length 7 → error
30. **Confidence always 1.0** — SCC detection is exact
31. **Metadata includes members, names, files, edgeKinds** — all fields populated
32. **No cycle patterns → no cycle insights** — graceful empty case
33. **relatedPatterns matches metadata.members** — sorted consistently

#### Deep Dependency Chain Tests

34. **Chain exceeding threshold detected** — 10-node chain with threshold 8 → 1 insight
35. **Chain at threshold not detected** — exactly 8 nodes with threshold 8 → 0 insights
36. **Cycle nodes don't cause infinite recursion** — graph with cycle still terminates
37. **Multiple roots, deepest chain reported** — verify deduplication by leaf
38. **Import edges excluded** — only semantic edges (render, hook-usage, etc.) counted
39. **Chain metadata has correct order** — root → leaf, not reversed
40. **Severity: error for 2x threshold** — depth 17 with threshold 8 → error

#### Mixed Styling Tests

41. **Project-level: 3+ technologies → insight** — tailwind + emotion + css-modules → warning
42. **Project-level: paradigm clash → error** — tailwind + styled-components → error even if only 2
43. **Project-level: single technology → no insight** — only tailwind → no mixed-styling
44. **File-level: 2+ approaches → insight** — tailwind + inline-styles in one file → info
45. **File-level: single approach → no insight** — only tailwind → no insight
46. **No styling profile → no project insight** — graceful degradation
47. **Metadata includes technology breakdown** — tally, primary, isParadigmClash all correct

#### Architectural Smell Tests

48. **god-component detected** — component rendering 12 others (threshold 10) → warning
49. **god-component: severity escalation** — 21 children → error
50. **wrong-directory: component in utils/** — component pattern in utils dir → info
51. **wrong-directory: utility in components/** — utility pattern in components dir → info
52. **wrong-directory: infrastructure patterns excluded** — "module", "stylesheet" patterns NOT flagged
53. **excessive-props detected** — component with 18 props (threshold 15) → warning
54. **excessive-props: at threshold not detected** — exactly 15 props → no insight
55. **inconsistent-naming detected** — directory using camelCase when project uses PascalCase → info
56. **inconsistent-naming: small directories excluded** — < 3 files not flagged
57. **inconsistent-naming: "unknown" convention excluded** — unknown naming doesn't trigger
58. **missing-barrel detected** — components dir with 5 files, no index → info
59. **missing-barrel: small directories excluded** — < 3 files not flagged
60. **missing-barrel: only component/hook dirs** — utils dir without barrel NOT flagged

#### Integration Tests

61. **Full pipeline integration** — create temp project → run full pipeline (discovery → orchestrator → normalizer → indexer → InsightEngine) → verify insights reference valid PatternIds
62. **All insight IDs are unique** — no duplicates in output
63. **All relatedPatterns exist in index** — every referenced PatternId resolves to a pattern
64. **Insights survive normalization round-trip** — `JSON.parse(stableStringify(insights))` is identical
65. **Large synthetic index** — 500 components, 2000 edges → engine completes in < 200ms

### Verification Commands

```bash
npm run typecheck        # TypeScript strict mode passes
npm run lint             # ESLint passes
npm run build            # tsup build succeeds
npm run test             # All manual tests pass
npm run test:vitest      # Vitest tests pass
```

---

## Appendix A: Default Configuration Values

```typescript
const DEFAULT_CONFIG: InsightEngineConfig = {
  hubInDegreeThreshold: 5,
  hubPercentileThreshold: 0.90,
  orphanExcludeTypes: ["page", "layout", "provider"],
  orphanExcludeRoles: ["pages", "layouts", "root"],
  deepChainThreshold: 8,
  mixedStylingMinTechnologies: 3,
  mixedStylingFileThreshold: 2,
  godComponentOutDegree: 10,
  excessivePropCount: 15,
  missingBarrelMinExports: 3,
  maxInsightsPerCategory: 50,
};
```

---

## Appendix B: InsightEngine is NOT an Analyzer

| Property | Analyzer | InsightEngine |
|---|---|---|
| Input | `AnalyzerContext` (files, cache) | `IntelligenceIndex` (merged index) |
| Output | `AnalyzerOutput` (patterns, diagnostics) | `InsightEngineResult` (insights, stats) |
| Pipeline stage | Orchestrator-managed | Post-indexer |
| File I/O | Reads source files | None (pure computation) |
| Determinism | Hash of patterns + diagnostics | Hash of insights |
| Dependencies | Other analyzers | All analyzers (via merged index) |
| Registration | `AnalyzerOrchestrator` constructor | Called directly after indexer |

The InsightEngine is a separate pipeline stage, not plugged into the orchestrator. It has no `fileFilter`, no `analyze()` method, and no `AnalyzerOutput`. It operates on the final merged product of all analyzers.

---

## Appendix C: Edge Cases

| Case | Handling |
|---|---|
| Empty index (0 entries, 0 edges) | Return empty insights, all stats = 0 |
| No component patterns | Hub/orphan/god-component detectors return [] |
| No DependencyAnalyzer output | No cycle/dep patterns in index → cycle/chain detectors return [] |
| No StylingAnalyzer output | No styling profile → mixed-styling returns [] |
| No FileStructureAnalyzer output | No directory patterns → wrong-directory/inconsistent-naming/missing-barrel return [] |
| Only stub StructureAnalyzer patterns | StructureAnalyzer patterns have no metadata fields → all detectors handle undefined gracefully |
| Very large graph (10k+ components) | maxInsightsPerCategory cap prevents output explosion; O(V+E) algorithms stay linear |
| Graph with only self-loops | Cycles of length 1 are already handled by DependencyAnalyzer |
| Component with 0 props metadata | `metadata.propCount` undefined → skip excessive-props check (no error) |
| Directory pattern without role | `metadata.role` undefined → treated as "unknown", not flagged |
| DependencyEdge to non-existent pattern | relatedPatterns filters via `index.entries.has()` — orphaned edges silently excluded |

---

## Appendix D: Future Extension Points

These are NOT part of the current design — they describe how the engine can grow without architectural changes:

1. **New insight categories** — add a new `detect*` method + category to `InsightCategory` union
2. **Custom thresholds per project** — `InsightEngineConfig` loaded from `.uiquarterrc` or `package.json`
3. **Insight suppression** — `// uiq-ignore-insight:hub-component` comment-based suppression
4. **Insight diff** — compare two `InsightEngineResult` to show what changed between builds
5. **Severity override** — project-level config to promote/demote specific insight categories
