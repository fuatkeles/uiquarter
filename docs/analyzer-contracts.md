# Analyzer Contracts — Pattern Metadata Reference

Cross-analyzer metadata field documentation for UIQuarter Phase 2.5.

---

## 1. StructureAnalyzer (DEPRECATED)

**Name:** `structure` | **Version:** `0.1.0` | **Dependencies:** none | **Status:** deprecated

Superseded by ComponentAnalyzer + FileStructureAnalyzer. Retained for backward compatibility.

### Pattern: `${filePath}:${name}:1`
| Field | Type | Description |
|---|---|---|
| *(none)* | — | Empty metadata object `{}` |

### Diagnostics
| Code | Severity | Message |
|---|---|---|
| STR001 | info | StructureAnalyzer is deprecated — superseded by ComponentAnalyzer + FileStructureAnalyzer |

---

## 2. ImportAnalyzer

**Name:** `import` | **Version:** `0.1.0` | **Dependencies:** none

### Pattern: `${filePath}:module:1`
| Field | Type | Description |
|---|---|---|
| `importCount` | `number` | Total import statements in file |
| `externalPackages` | `string[]` | Sorted unique external package names |
| `internalImports` | `string[]` | Sorted unique internal import specifiers |
| `isBarrel` | `boolean` | True if file is a barrel (re-export-only) |
| `hasDynamicImports` | `boolean` | True if file uses `import()` |
| `hasRequireCalls` | `boolean` | True if file uses `require()` |
| `hasTypeOnlyImports` | `boolean` | True if file has `import type` |
| `imports` | `ImportMetadataEntry[]` | Full import details (see below) |
| `reExports` | `ReExportMetadataEntry[]` | Re-export details |

#### ImportMetadataEntry
| Field | Type | Description |
|---|---|---|
| `specifier` | `string` | Import specifier (e.g., `"react"`, `"./utils"`) |
| `statementKind` | `string` | `"import"`, `"re-export"`, `"require"`, `"dynamic"` |
| `symbols` | `ImportedSymbol[]` | Imported symbols with name/alias/isType |
| `isTypeOnly` | `boolean` | Whether it's a type-only import |
| `line` | `number` | Source line number |
| `resolvedPath?` | `string` | Resolved internal path (only for internal imports) |

### Diagnostics
| Code | Severity | Message |
|---|---|---|
| IMP001 | warning | Dynamic import with non-literal specifier |
| IMP002 | info | Barrel file detected |
| IMP003 | warning | Circular import detected |

### Normalizer Compatibility
- `isBarrel: true` → passes through as boolean (no DEFAULT_METADATA_KEY_MAP entry)
- All other booleans pass through as-is (not in key map)

---

## 3. ComponentAnalyzer

**Name:** `component` | **Version:** `1.0.0` | **Dependencies:** `["import"]`

### Pattern: `${filePath}:${name}:${line}` (component)
| Field | Type | Description |
|---|---|---|
| `componentKind` | `string` | `"function"`, `"arrow"`, `"class"`, `"hoc"` |
| `isDefaultExport` | `boolean` | Whether component is default-exported |
| `isNamedExport` | `boolean` | Whether component is named-exported |
| `wrappers` | `{wrapper, line}[]` | HOC/forwardRef wrappers applied |
| `jsx.childComponentRefs` | `string[]` | Component tags referenced in JSX |
| `jsx.htmlElementCount` | `number` | HTML elements in JSX |
| `jsx.componentElementCount` | `number` | Component elements in JSX |
| `jsx.hasConditionalRendering` | `boolean` | Ternary/logical in JSX |
| `jsx.hasListRendering` | `boolean` | `.map()` in JSX |
| `jsx.hasFragments` | `boolean` | `<>` or `<Fragment>` usage |
| `jsx.depth` | `number` | Max JSX nesting depth |
| `propCount` | `number` | Total prop count |
| `requiredPropCount` | `number` | Required props count |
| `hasChildren` | `boolean` | Whether component accepts children |
| `hasRef` | `boolean` | Whether wrapped with forwardRef |

### Pattern: `${filePath}:${name}:${line}` (hook)
| Field | Type | Description |
|---|---|---|
| `hookCalls` | `string[]` | Hooks called inside this hook |
| `parameterCount` | `number` | Number of parameters |
| `isDefaultExport` | `boolean` | Whether hook is default-exported |
| `isNamedExport` | `boolean` | Whether hook is named-exported |

### Diagnostics
| Code | Severity | Message |
|---|---|---|
| CMP006 | warning | ImportAnalyzer output not available |

### Normalizer Compatibility
- All metadata is non-boolean-flag (objects, numbers, strings, arrays) — passes through unchanged

---

## 4. StylingAnalyzer

**Name:** `styling` | **Version:** `1.0.0` | **Dependencies:** `["import"]`

### Pattern: `${filePath}:stylesheet:1` (CSS/SCSS/SASS/LESS files)
| Field | Type | Description |
|---|---|---|
| `technology` | `string` | `"css"`, `"scss"`, `"sass"`, `"less"` |
| `isCssModule` | `boolean` | True if filename matches `.module.*` |
| `classCount` | `number` | Number of class selectors |
| `idCount` | `number` | Number of ID selectors |
| `elementCount` | `number` | Number of element selectors |
| `pseudoCount` | `number` | Number of pseudo selectors |
| `mediaQueryCount` | `number` | Number of @media queries |
| `totalRuleCount` | `number` | Total CSS rule count |
| `customPropertyDefinitions` | `string[]` | `--var` definitions |
| `customPropertyUsages` | `string[]` | `var(--...)` usages |
| `tailwindDirectives` | `string[]` | `@tailwind`, `@apply` directives |
| `importStatements` | `string[]` | `@import` statements |
| `size` | `number` | File size in bytes |

### Pattern: `${filePath}:styling:1` (source files with styling)
| Field | Type | Description |
|---|---|---|
| `tailwind` | `boolean` | **Normalizer mapped** → `{ styling: "tailwind" }` |
| `styled-components` | `boolean` | **Normalizer mapped** → `{ styling: "styled-components" }` |
| `emotion` | `boolean` | **Normalizer mapped** → `{ styling: "emotion" }` |
| `vanilla-extract` | `boolean` | **Normalizer mapped** → `{ styling: "vanilla-extract" }` |
| `css-modules` | `boolean` | **Normalizer mapped** → `{ styling: "css-modules" }` |
| `inline-styles` | `boolean` | **Normalizer mapped** → `{ styling: "inline-styles" }` |
| `tailwindClassCount` | `number` | Estimated Tailwind class usage count |
| `tailwindDynamicClassCount` | `number` | Dynamic class bindings |
| `tailwindUtilityPrefixes` | `string[]` | Unique Tailwind utility prefixes |
| `cssModuleBindings` | `string[]` | CSS module import bindings |
| `styledCallCount` | `number` | `styled()` call count |
| `styledCssCallCount` | `number` | `css\`\`` call count (styled-components) |
| `styledComponentNames` | `string[]` | Named styled components |
| `emotionCssCallCount` | `number` | Emotion `css()` call count |
| `emotionStyledCallCount` | `number` | Emotion `styled()` call count |
| `emotionCxCallCount` | `number` | Emotion `cx()` call count |
| `vanillaExtractStyleCallCount` | `number` | `style()` call count |
| `vanillaExtractRecipeCallCount` | `number` | `recipe()` call count |
| `vanillaExtractGlobalStyleCallCount` | `number` | `globalStyle()` call count |
| `inlineStyleCount` | `number` | `style={}` JSX attribute count |

### Pattern: `.:styling-profile:1` (project-wide)
| Field | Type | Description |
|---|---|---|
| `primaryApproach` | `string` | Dominant styling technology |
| `secondaryApproaches` | `string[]` | Other styling technologies in use |
| `technologyTally` | `Record<string, number>` | Per-technology file counts |
| `customPropertyCount` | `number` | Total custom property definitions |
| `customPropertyNames` | `string[]` | Unique custom property names |
| `designTokenPatterns` | `string[]` | Detected design token patterns |
| `cssModuleFileCount` | `number` | Files using CSS modules |
| `tailwindFileCount` | `number` | Files using Tailwind |
| `cssInJsFileCount` | `number` | Files using CSS-in-JS |
| `plainCssFileCount` | `number` | Plain CSS files |
| `preprocessorFileCount` | `number` | SCSS/SASS/LESS files |
| `totalStyleFiles` | `number` | Total style files |
| `totalStyledSourceFiles` | `number` | Source files with styling |
| `hasTailwindConfig` | `boolean` | Tailwind config file detected |
| `hasPostcssConfig` | `boolean` | PostCSS config file detected |

### Diagnostics
| Code | Severity | Message |
|---|---|---|
| STY001 | info | Import analyzer not available; using filename heuristic |
| STY002 | info | CSS module detected |
| STY003 | info | Tailwind config detected |
| STY004 | info | PostCSS config detected |
| STY005 | info | Large stylesheet detected (>500 rules) |
| STY006 | warning | Mixed CSS-in-JS and inline styles |

### Normalizer Compatibility
- Boolean flags (`tailwind`, `styled-components`, `emotion`, `vanilla-extract`, `css-modules`, `inline-styles`) are mapped via DEFAULT_METADATA_KEY_MAP to `{ styling: "<value>" }` format
- All other fields pass through as-is

---

## 5. FileStructureAnalyzer

**Name:** `file-structure` | **Version:** `1.0.0` | **Dependencies:** `["import"]`

### Pattern: `${dirPath}:directory:1` (per-directory)
| Field | Type | Description |
|---|---|---|
| `role` | `string` | Directory role (`"components"`, `"hooks"`, `"utils"`, etc.) |
| `roleScore` | `number` | 0-1 confidence in role classification |
| `fileCount` | `number` | Direct child file count |
| `childDirCount` | `number` | Direct child directory count |
| `depth` | `number` | Directory depth (root = 0) |
| `parent` | `string\|null` | Parent directory path |
| `childDirs` | `string[]` | Child directory paths |
| `namingConvention` | `string` | Dominant naming case in directory |
| `hasBarrel` | `boolean` | Whether directory has a barrel file |
| `barrelFile` | `string\|null` | Path to barrel file |
| `isComponentDir` | `boolean` | Whether it's a component directory |
| `componentDirInfo` | `object\|null` | Component dir details (primary, test, style files) |
| `coLocatedTests` | `string[]` | Co-located test file paths |
| `coLocatedStyles` | `string[]` | Co-located style file paths |
| `coLocatedStories` | `string[]` | Co-located story file paths |
| `extensions` | `string[]` | Unique file extensions in directory |

### Pattern: `.:conventions:1` (project-wide)
| Field | Type | Description |
|---|---|---|
| `dominantFileNaming` | `string` | Project-wide file naming convention |
| `dominantDirNaming` | `string` | Project-wide directory naming convention |
| `fileTally` | `Record<string, number>` | Per-convention file counts |
| `dirTally` | `Record<string, number>` | Per-convention directory counts |
| `testStrategy` | `string` | `"co-located"`, `"separated"`, `"mixed"` |
| `testCoLocationRate` | `number` | 0-1 test co-location rate |
| `styleStrategy` | `string` | `"co-located"`, `"separated"`, `"mixed"` |
| `styleCoLocationRate` | `number` | 0-1 style co-location rate |
| `storyStrategy` | `string` | `"co-located"`, `"separated"`, `"mixed"` |
| `storyCoLocationRate` | `number` | 0-1 story co-location rate |
| `separateTestDirs` | `string[]` | Directories classified as test dirs |
| `separateStyleDirs` | `string[]` | Directories classified as style dirs |
| `barrelCount` | `number` | Total barrel files detected |
| `componentDirCount` | `number` | Total component directories |
| `averageDepth` | `number` | Average directory depth |
| `maxDepth` | `number` | Maximum directory depth |
| `totalDirectories` | `number` | Total directories analyzed |
| `totalFiles` | `number` | Total files in tree |

### Diagnostics
| Code | Severity | Message |
|---|---|---|
| FSA001 | info | ImportAnalyzer output not available; barrel detection using filename heuristic only |
| FSA003 | info | Component directory detected |
| FSA004 | info | Mixed naming conventions in directory |
| FSA005 | warning | Inconsistent file naming across project |

### Normalizer Compatibility
- All metadata is non-boolean-flag (strings, numbers, arrays, objects) — passes through unchanged

---

## 6. DependencyAnalyzer

**Name:** `dependency` | **Version:** `1.0.0` | **Dependencies:** `["component", "import"]`

### Pattern: `${filePath}:${name}:dep:1` (per-component dependency node)
| Field | Type | Description |
|---|---|---|
| `sourcePatternId` | `PatternId` | Original component pattern ID |
| `edges` | `EdgeEntry[]` | Typed dependency edges (see below) |
| `renderDependencyCount` | `number` | Components rendered by this component |
| `hookUsageCount` | `number` | Hooks used by this component |
| `hocWrappingCount` | `number` | HOC wrappings detected |
| `providerCount` | `number` | Context providers used |
| `totalEdgeCount` | `number` | Total outgoing edges |
| `inDegree` | `number` | Incoming edge count |
| `outDegree` | `number` | Outgoing edge count |
| `isInCycle` | `boolean` | Whether node participates in a cycle |

#### EdgeEntry (in metadata.edges)
| Field | Type | Description |
|---|---|---|
| `target` | `PatternId` | Target pattern ID |
| `kind` | `string` | `"render"`, `"hook-usage"`, `"hoc-wrapping"`, `"provider"` |
| `targetName` | `string` | Name of target component/hook |
| `targetFile` | `string` | File path of target |
| `confidence` | `number` | 0-1 edge confidence |

**IntelligenceIndexer integration:** `metadata.edges[].target` and `metadata.edges[].kind` are read by `buildEdges()` to produce typed `DependencyEdge` entries. Fallback to `"import"` when `metadata.edges` is absent.

### Pattern: `.:dependency-graph:1` (project-wide graph metrics)
| Field | Type | Description |
|---|---|---|
| `totalNodes` | `number` | Total nodes in dependency graph |
| `totalEdges` | `number` | Total edges in dependency graph |
| `edgesByKind` | `Record<EdgeKind, number>` | Edge counts by kind |
| `maxInDegree` | `number` | Maximum incoming edges on any node |
| `maxOutDegree` | `number` | Maximum outgoing edges on any node |
| `maxInDegreeNode` | `PatternId\|null` | Node with most incoming edges |
| `maxOutDegreeNode` | `PatternId\|null` | Node with most outgoing edges |
| `orphanCount` | `number` | Components with no edges |
| `orphanNodes` | `PatternId[]` | Orphan node IDs |
| `cycleCount` | `number` | Number of dependency cycles |
| `maxCycleLength` | `number` | Longest cycle length |
| `averageOutDegree` | `number` | Mean outgoing edges |
| `maxDepth` | `number` | Maximum dependency depth |
| `componentCount` | `number` | Total components analyzed |

### Pattern: `.:cycle:${i}:1` (per-cycle)
| Field | Type | Description |
|---|---|---|
| `cycleIndex` | `number` | 1-based cycle index |
| `members` | `PatternId[]` | Cycle member IDs |
| `memberNames` | `string[]` | Cycle member names |
| `length` | `number` | Cycle length |
| `edgeKinds` | `string[]` | Edge kinds in cycle |
| `severity` | `string` | `"info"` or `"warning"` (>5 members) |

### Diagnostics
| Code | Severity | Message |
|---|---|---|
| DEP001 | info | ComponentAnalyzer output not available |
| DEP002 | info | ImportAnalyzer output not available |
| DEP003 | info | Dependency cycle detected |

### Normalizer Compatibility
- `isInCycle: true/false` — not in DEFAULT_METADATA_KEY_MAP, passes to `flags` array if true
- All other fields are non-boolean — pass through unchanged

---

## PatternId Formats (Collision-Free)

| Analyzer | Format | Example |
|---|---|---|
| StructureAnalyzer | `${filePath}:${fileName}:1` | `src/Button.tsx:Button:1` |
| ImportAnalyzer | `${filePath}:module:1` | `src/Button.tsx:module:1` |
| ComponentAnalyzer | `${filePath}:${name}:${line}` | `src/Button.tsx:Button:5` |
| StylingAnalyzer | `${filePath}:stylesheet:1` | `src/style.css:stylesheet:1` |
| StylingAnalyzer | `${filePath}:styling:1` | `src/Button.tsx:styling:1` |
| StylingAnalyzer | `.:styling-profile:1` | `.:styling-profile:1` |
| FileStructureAnalyzer | `${dirPath}:directory:1` | `src/components:directory:1` |
| FileStructureAnalyzer | `.:conventions:1` | `.:conventions:1` |
| DependencyAnalyzer | `${filePath}:${name}:dep:1` | `src/Button.tsx:Button:dep:1` |
| DependencyAnalyzer | `.:dependency-graph:1` | `.:dependency-graph:1` |
| DependencyAnalyzer | `.:cycle:${i}:1` | `.:cycle:1:1` |

---

## DependencyEdge.kind Values

| Kind | Source | Description |
|---|---|---|
| `import` | IntelligenceIndexer (default) | ES import dependency |
| `render` | DependencyAnalyzer | Component renders another component |
| `hook-usage` | DependencyAnalyzer | Component/hook uses a custom hook |
| `hoc-wrapping` | DependencyAnalyzer | Component is wrapped by HOC |
| `provider` | DependencyAnalyzer | Component uses a context provider |
| `slot` | (reserved) | Vue slot usage |
| `inject` | (reserved) | Vue provide/inject |
| `extend` | (reserved) | Class extension |

---

## Execution Context

All analyzers receive `AnalyzerContext` with:
- `schemaVersion?: "2.0"` — set by orchestrator (Phase 2.5+)
- `dependencyOutputs` — frozen snapshot of completed dependency outputs

All outputs are augmented by the orchestrator with:
```typescript
metadata: {
  execution: {
    timeMs: number,
    patternCount: number,
    diagnosticCount: number,
  }
}
```
