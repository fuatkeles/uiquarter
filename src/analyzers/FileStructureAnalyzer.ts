import { createHash } from "node:crypto";
import { compare, stableStringify } from "../core/utils.js";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerOutput,
  AnalyzerDiagnostic,
  AnalyzerId,
  OutputHash,
  PatternId,
  DiscoveredFile,
  PatternResult,
  ConfidenceScore,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STRUCTURE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "vue", "svelte",
  "css", "scss", "sass", "less",
  "json", "md", "mdx",
]);

const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "vue", "svelte",
]);

const COMPONENT_EXTENSIONS = new Set(["tsx", "jsx", "vue", "svelte"]);

const STYLE_EXTENSIONS = new Set(["css", "scss", "sass", "less"]);

const INDEX_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);

/** TypeScript resolution order for naming — not used for resolution itself */
const NAMING_PREFERENCE: NamingCase[] = [
  "PascalCase", "camelCase", "kebab-case", "snake_case", "UPPER_CASE", "unknown",
];

// ---------------------------------------------------------------------------
// Directory role name → patterns mapping
// ---------------------------------------------------------------------------

const ROLE_NAME_MAP: ReadonlyMap<string, DirectoryRole> = new Map([
  // components
  ["components", "components"], ["component", "components"], ["comps", "components"],
  ["ui", "components"], ["atoms", "components"], ["molecules", "components"], ["organisms", "components"],
  // hooks
  ["hooks", "hooks"], ["composables", "hooks"],
  // utils
  ["utils", "utils"], ["utilities", "utils"], ["helpers", "utils"], ["shared", "utils"],
  // lib
  ["lib", "lib"],
  // pages
  ["pages", "pages"], ["routes", "pages"], ["views", "pages"], ["screens", "pages"],
  // layouts
  ["layouts", "layouts"], ["layout", "layouts"],
  // styles
  ["styles", "styles"], ["style", "styles"], ["css", "styles"], ["scss", "styles"],
  ["themes", "styles"], ["theme", "styles"],
  // tests
  ["tests", "tests"], ["test", "tests"], ["__tests__", "tests"], ["__test__", "tests"],
  ["spec", "tests"], ["specs", "tests"], ["e2e", "tests"], ["integration", "tests"],
  // config
  ["config", "config"], ["configs", "config"], ["configuration", "config"],
  // assets
  ["assets", "assets"], ["images", "assets"], ["icons", "assets"], ["fonts", "assets"],
  ["media", "assets"], ["static", "assets"], ["public", "assets"],
  // types
  ["types", "types"], ["typings", "types"], ["interfaces", "types"], ["@types", "types"],
  // constants
  ["constants", "constants"], ["const", "constants"], ["enums", "constants"],
  // services
  ["services", "services"], ["service", "services"],
  // api
  ["api", "api"], ["apis", "api"], ["endpoints", "api"],
  // stores
  ["stores", "stores"], ["store", "stores"], ["state", "stores"],
  // models
  ["models", "models"], ["model", "models"], ["entities", "models"],
]);

// ---------------------------------------------------------------------------
// Internal types (file-private)
// ---------------------------------------------------------------------------

type NamingCase =
  | "PascalCase"
  | "camelCase"
  | "kebab-case"
  | "snake_case"
  | "UPPER_CASE"
  | "unknown";

type DirectoryRole =
  | "components" | "hooks" | "utils" | "pages" | "layouts"
  | "styles" | "tests" | "config" | "assets" | "types"
  | "constants" | "services" | "api" | "stores" | "models"
  | "lib" | "component-directory" | "root" | "mixed" | "unknown";

interface DirectoryNode {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly files: readonly string[];
  readonly childDirs: readonly string[];
  readonly parent: string | null;
}

interface DirectoryTree {
  readonly nodes: ReadonlyMap<string, DirectoryNode>;
  readonly filesByPath: ReadonlyMap<string, DiscoveredFile>;
}

interface NamingResult {
  readonly dominant: NamingCase;
  readonly consistency: number;
  readonly counts: Readonly<Record<NamingCase, number>>;
}

interface RoleResult {
  readonly role: DirectoryRole;
  readonly score: number;
  readonly nameScore: number;
  readonly contentScore: number;
}

interface ColocationResult {
  readonly coLocatedTests: readonly string[];
  readonly coLocatedStyles: readonly string[];
  readonly coLocatedStories: readonly string[];
}

interface BarrelResult {
  readonly hasBarrel: boolean;
  readonly barrelFile: string | null;
  readonly fromImportAnalyzer: boolean;
}

interface ComponentDirResult {
  readonly primaryFile: string;
  readonly indexFile: string | null;
  readonly testFiles: readonly string[];
  readonly styleFiles: readonly string[];
  readonly storyFiles: readonly string[];
  readonly otherFiles: readonly string[];
}

interface DirectoryAnalysis {
  readonly node: DirectoryNode;
  readonly role: RoleResult;
  readonly naming: NamingResult;
  readonly colocation: ColocationResult;
  readonly barrel: BarrelResult;
  readonly componentDir: ComponentDirResult | null;
  readonly extensions: readonly string[];
}

interface ImportDataIndex {
  readonly barrelFiles: ReadonlySet<string>;
  readonly available: boolean;
}

interface ProjectConventions {
  readonly dominantFileNaming: NamingCase;
  readonly dominantDirNaming: NamingCase;
  readonly fileTally: Readonly<Record<NamingCase, number>>;
  readonly dirTally: Readonly<Record<NamingCase, number>>;
  readonly testStrategy: "co-located" | "separated" | "mixed";
  readonly testCoLocationRate: number;
  readonly styleStrategy: "co-located" | "separated" | "mixed";
  readonly styleCoLocationRate: number;
  readonly storyStrategy: "co-located" | "separated" | "mixed";
  readonly storyCoLocationRate: number;
  readonly separateTestDirs: readonly string[];
  readonly separateStyleDirs: readonly string[];
  readonly barrelCount: number;
  readonly componentDirCount: number;
  readonly averageDepth: number;
  readonly maxDepth: number;
  readonly totalDirectories: number;
  readonly totalFiles: number;
}

// ---------------------------------------------------------------------------
// File classification helpers
// ---------------------------------------------------------------------------

function getBaseName(relativePath: string): string {
  const parts = relativePath.split("/");
  const fileName = parts[parts.length - 1]!;
  const dotIndex = fileName.indexOf(".");
  return dotIndex === -1 ? fileName : fileName.slice(0, dotIndex);
}

function getFileName(relativePath: string): string {
  const parts = relativePath.split("/");
  return parts[parts.length - 1]!;
}

function getExtension(relativePath: string): string {
  const fileName = getFileName(relativePath);
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex + 1);
}

function getNameWithoutFinalExt(relativePath: string): string {
  const fileName = getFileName(relativePath);
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? fileName : fileName.slice(0, dotIndex);
}

function getParentDir(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "." : normalized.slice(0, lastSlash);
}

function isTestFile(relativePath: string): boolean {
  const nameNoExt = getNameWithoutFinalExt(relativePath);
  return nameNoExt.endsWith(".test") || nameNoExt.endsWith(".spec") ||
         nameNoExt.endsWith("_test") || nameNoExt.endsWith("_spec");
}

function isStoryFile(relativePath: string): boolean {
  const nameNoExt = getNameWithoutFinalExt(relativePath);
  return nameNoExt.endsWith(".stories") || nameNoExt.endsWith(".story");
}

function isStyleFile(relativePath: string): boolean {
  return STYLE_EXTENSIONS.has(getExtension(relativePath));
}

function isSourceFile(relativePath: string): boolean {
  const ext = getExtension(relativePath);
  return SOURCE_EXTENSIONS.has(ext) && !isTestFile(relativePath) && !isStoryFile(relativePath);
}

function isIndexFile(relativePath: string): boolean {
  const baseName = getBaseName(relativePath);
  const ext = getExtension(relativePath);
  return baseName === "index" && INDEX_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Naming convention classification
// ---------------------------------------------------------------------------

function classifyNamingCase(name: string): NamingCase {
  // Strip extension if present
  const dotIndex = name.indexOf(".");
  const baseName = dotIndex === -1 ? name : name.slice(0, dotIndex);

  if (baseName.length === 0 || baseName.startsWith(".")) return "unknown";

  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(baseName)) return "UPPER_CASE";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(baseName)) return "PascalCase";
  if (/^[a-z][a-zA-Z0-9]*$/.test(baseName) && /[A-Z]/.test(baseName)) return "camelCase";
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(baseName)) return "kebab-case";
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(baseName)) return "snake_case";
  if (/^[a-z][a-z0-9]*$/.test(baseName)) return "camelCase"; // single lowercase word

  return "unknown";
}

function emptyNamingCounts(): Record<NamingCase, number> {
  return {
    PascalCase: 0,
    camelCase: 0,
    "kebab-case": 0,
    snake_case: 0,
    UPPER_CASE: 0,
    unknown: 0,
  };
}

function pickDominant(counts: Record<NamingCase, number>): NamingCase {
  let maxCount = 0;
  let dominant: NamingCase = "unknown";

  for (const pref of NAMING_PREFERENCE) {
    if (counts[pref] > maxCount) {
      maxCount = counts[pref];
      dominant = pref;
    }
  }

  return dominant;
}

function computeStrategy(rate: number): "co-located" | "separated" | "mixed" {
  if (rate >= 0.7) return "co-located";
  if (rate <= 0.3) return "separated";
  return "mixed";
}

// ---------------------------------------------------------------------------
// FileStructureAnalyzer
// ---------------------------------------------------------------------------

export class FileStructureAnalyzer implements Analyzer {
  readonly name = "file-structure";
  readonly version = "1.0.0";
  readonly capabilities = [
    "directory-classification",
    "co-location-detection",
    "naming-convention-detection",
    "barrel-detection",
    "component-directory-detection",
  ] as const;
  readonly dependencies = ["import"] as const;

  fileFilter(file: DiscoveredFile): boolean {
    return STRUCTURE_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const startTime = Date.now();
    const diagnostics: AnalyzerDiagnostic[] = [];

    // ── Phase 1: Preparation ──────────────────────────────────────────────
    const importData = this.extractImportData(context, diagnostics);
    const tree = this.buildDirectoryTree(context.files);

    // ── Phase 2: Per-directory analysis ───────────────────────────────────
    const analyses: DirectoryAnalysis[] = [];
    const sortedPaths = [...tree.nodes.keys()].sort(compare);

    for (const dirPath of sortedPaths) {
      if (context.signal?.aborted === true) break;

      const node = tree.nodes.get(dirPath)!;
      const analysis = this.analyzeDirectory(node, tree, importData, diagnostics);
      analyses.push(analysis);
    }

    // ── Phase 3: Project-wide aggregation ─────────────────────────────────
    const conventions = this.aggregateConventions(analyses, tree);

    // FSA005: inconsistent naming
    const totalNamingFiles = Object.values(conventions.fileTally).reduce((a, b) => a + b, 0);
    if (totalNamingFiles > 0) {
      const dominantCount = conventions.fileTally[conventions.dominantFileNaming];
      const pct = Math.round((dominantCount / totalNamingFiles) * 100);
      if (pct < 50) {
        diagnostics.push({
          severity: "warning",
          filePath: ".",
          message: `FSA005 Inconsistent file naming across project: dominant "${conventions.dominantFileNaming}" covers only ${pct}% of files`,
          line: 1,
          column: 0,
        });
      }
    }

    // ── Phase 4: Output construction ──────────────────────────────────────
    const patterns: PatternResult[] = [];

    for (const analysis of analyses) {
      patterns.push(this.buildDirectoryPattern(analysis));
    }

    patterns.push(this.buildConventionsPattern(conventions, context.files.length));

    // Sort patterns by id
    patterns.sort((a, b) => compare(a.id as string, b.id as string));

    // Sort diagnostics deterministically
    diagnostics.sort((a, b) =>
      compare(a.filePath, b.filePath) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      compare(a.severity, b.severity) ||
      compare(a.message, b.message),
    );

    // Hash
    const hashPayload = stableStringify({ patterns, diagnostics });
    const hash = createHash("sha256").update(hashPayload).digest("hex") as OutputHash;

    return {
      analyzerId: `${this.name}@${this.version}` as AnalyzerId,
      patterns,
      diagnostics,
      hash,
      duration: Date.now() - startTime,
      stats: {
        totalFiles: context.files.length,
        analyzedFiles: analyses.length,
        cacheHits: 0,
        cacheMisses: analyses.length,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Phase 1: Preparation
  // -----------------------------------------------------------------------

  private extractImportData(
    context: AnalyzerContext,
    diagnostics: AnalyzerDiagnostic[],
  ): ImportDataIndex {
    const importOutput = context.dependencyOutputs.get("import");
    if (!importOutput) {
      diagnostics.push({
        severity: "info",
        filePath: ".",
        message: "FSA001 ImportAnalyzer output not available; barrel detection using filename heuristic only",
        line: 1,
        column: 0,
      });
      return { barrelFiles: new Set(), available: false };
    }

    const barrelFiles = new Set<string>();
    for (const pattern of importOutput.patterns) {
      if (pattern.metadata.isBarrel === true) {
        barrelFiles.add(pattern.filePath);
      }
    }

    return { barrelFiles, available: true };
  }

  private buildDirectoryTree(files: readonly DiscoveredFile[]): DirectoryTree {
    const mutableNodes = new Map<string, {
      path: string;
      name: string;
      depth: number;
      files: string[];
      childDirs: Set<string>;
      parent: string | null;
    }>();

    const filesByPath = new Map<string, DiscoveredFile>();

    // Ensure root exists
    mutableNodes.set(".", {
      path: ".",
      name: ".",
      depth: 0,
      files: [],
      childDirs: new Set(),
      parent: null,
    });

    for (const file of files) {
      const relativePath = file.relativePath.replace(/\\/g, "/");
      filesByPath.set(relativePath, file);

      const parentDir = getParentDir(relativePath);

      // Ensure all ancestor directories exist
      this.ensureDirectory(mutableNodes, parentDir);

      // Add file to its parent directory
      const parentNode = mutableNodes.get(parentDir)!;
      parentNode.files.push(relativePath);
    }

    // Build immutable tree
    const nodes = new Map<string, DirectoryNode>();
    for (const [path, mNode] of mutableNodes) {
      const sortedFiles = [...mNode.files].sort(compare);
      const sortedChildDirs = [...mNode.childDirs].sort(compare);
      nodes.set(path, {
        path: mNode.path,
        name: mNode.name,
        depth: mNode.depth,
        files: sortedFiles,
        childDirs: sortedChildDirs,
        parent: mNode.parent,
      });
    }

    return { nodes, filesByPath };
  }

  private ensureDirectory(
    nodes: Map<string, {
      path: string;
      name: string;
      depth: number;
      files: string[];
      childDirs: Set<string>;
      parent: string | null;
    }>,
    dirPath: string,
  ): void {
    if (nodes.has(dirPath)) return;

    const parts = dirPath.split("/");
    const name = parts[parts.length - 1]!;
    const depth = dirPath === "." ? 0 : parts.length;
    const parentPath = parts.length <= 1 ? "." : parts.slice(0, -1).join("/");

    // Recurse to ensure parent exists
    this.ensureDirectory(nodes, parentPath);

    nodes.set(dirPath, {
      path: dirPath,
      name,
      depth,
      files: [],
      childDirs: new Set(),
      parent: parentPath,
    });

    // Register as child of parent
    const parentNode = nodes.get(parentPath)!;
    parentNode.childDirs.add(dirPath);
  }

  // -----------------------------------------------------------------------
  // Phase 2: Per-directory analysis
  // -----------------------------------------------------------------------

  private analyzeDirectory(
    node: DirectoryNode,
    tree: DirectoryTree,
    importData: ImportDataIndex,
    diagnostics: AnalyzerDiagnostic[],
  ): DirectoryAnalysis {
    const role = this.classifyRole(node, tree);
    const naming = this.detectNamingConvention(node, tree);
    const colocation = this.detectColocation(node, tree);
    const barrel = this.detectBarrel(node, tree, importData);
    const componentDir = this.detectComponentDir(node, tree);

    // Collect sorted unique extensions
    const extSet = new Set<string>();
    for (const filePath of node.files) {
      const ext = getExtension(filePath);
      if (ext) extSet.add(ext);
    }
    const extensions = [...extSet].sort(compare);

    // Override role if component directory detected
    let finalRole = role;
    if (componentDir !== null) {
      const fileCount = node.files.length;
      const fileCountScore = fileCount <= 5 ? 1.0 : 0.7;
      const cdScore = 0.5 * 1.0 + 0.3 * 1.0 + 0.2 * fileCountScore;
      finalRole = {
        role: "component-directory",
        score: cdScore,
        nameScore: 1.0,
        contentScore: 1.0,
      };
    }

    // FSA003: component directory detected
    if (componentDir !== null) {
      diagnostics.push({
        severity: "info",
        filePath: node.path,
        message: `FSA003 Component directory detected: "${node.path}" (primary: "${componentDir.primaryFile}")`,
        line: 1,
        column: 0,
      });
    }

    // FSA004: mixed naming
    if (naming.dominant !== "unknown") {
      const totalCount = Object.values(naming.counts).reduce((a, b) => a + b, 0);
      if (totalCount > 0) {
        const significantConventions = NAMING_PREFERENCE.filter(
          nc => nc !== "unknown" && naming.counts[nc] / totalCount > 0.2,
        );
        if (significantConventions.length > 2) {
          diagnostics.push({
            severity: "info",
            filePath: node.path,
            message: `FSA004 Mixed naming conventions in "${node.path}"`,
            line: 1,
            column: 0,
          });
        }
      }
    }

    return {
      node,
      role: finalRole,
      naming,
      colocation,
      barrel,
      componentDir,
      extensions,
    };
  }

  private classifyRole(node: DirectoryNode, _tree: DirectoryTree): RoleResult {
    // Root directory
    if (node.path === ".") {
      return { role: "root", score: 1.0, nameScore: 1.0, contentScore: 1.0 };
    }

    // Name-based classification
    const lowerName = node.name.toLowerCase();
    let nameScore = 0;
    let nameRole: DirectoryRole = "unknown";

    // Dot-prefixed directories → config
    if (node.name.startsWith(".")) {
      nameRole = "config";
      nameScore = 1.0;
    } else {
      const mappedRole = ROLE_NAME_MAP.get(lowerName);
      if (mappedRole !== undefined) {
        nameRole = mappedRole;
        nameScore = 1.0;
      }
    }

    // Content-based classification
    let contentScore = 0;
    let contentRole: DirectoryRole = "unknown";

    if (node.files.length > 0) {
      let testCount = 0;
      let styleCount = 0;
      let componentCount = 0;
      let hookCount = 0;
      let plainTsJsCount = 0;

      for (const filePath of node.files) {
        const ext = getExtension(filePath);
        if (isTestFile(filePath)) {
          testCount++;
        } else if (STYLE_EXTENSIONS.has(ext)) {
          styleCount++;
        } else if (COMPONENT_EXTENSIONS.has(ext)) {
          componentCount++;
        } else if (ext === "ts" || ext === "js") {
          const baseName = getBaseName(filePath);
          if (baseName.startsWith("use") && /^use[A-Z]/.test(baseName)) {
            hookCount++;
          } else {
            plainTsJsCount++;
          }
        }
      }

      const total = node.files.length;
      const half = total / 2;

      if (testCount > half) {
        contentRole = "tests";
        contentScore = 1.0;
      } else if (styleCount > half) {
        contentRole = "styles";
        contentScore = 1.0;
      } else if (hookCount > half) {
        contentRole = "hooks";
        contentScore = 1.0;
      } else if (componentCount > half) {
        contentRole = "components";
        contentScore = 0.7;
      } else if (plainTsJsCount > half) {
        contentRole = "utils";
        contentScore = 0.5;
      }
    }

    // Depth heuristic
    let depthScore: number;
    if (node.depth === 0) {
      depthScore = 1.0;
    } else if (node.depth === 1) {
      depthScore = 0.5;
    } else {
      depthScore = 0.6;
    }

    // Pick winning role
    let role: DirectoryRole;
    if (nameScore > 0) {
      role = nameRole;
    } else if (contentScore > 0) {
      role = contentRole;
    } else {
      role = "unknown";
    }

    const totalScore = nameScore * 0.6 + contentScore * 0.25 + depthScore * 0.15;

    // Low-confidence fallback
    if (totalScore < 0.3) {
      const hasComponent = node.files.some(f => COMPONENT_EXTENSIONS.has(getExtension(f)));
      const hasNonComponent = node.files.some(f => {
        const ext = getExtension(f);
        return SOURCE_EXTENSIONS.has(ext) && !COMPONENT_EXTENSIONS.has(ext);
      });
      role = hasComponent && hasNonComponent ? "mixed" : "unknown";
    }

    return { role, score: totalScore, nameScore, contentScore };
  }

  private detectNamingConvention(node: DirectoryNode, _tree: DirectoryTree): NamingResult {
    const counts = emptyNamingCounts();
    let total = 0;

    for (const filePath of node.files) {
      const ext = getExtension(filePath);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      if (isTestFile(filePath) || isStoryFile(filePath)) continue;

      const baseName = getBaseName(filePath);
      if (baseName === "index") continue;

      const naming = classifyNamingCase(baseName);
      counts[naming]++;
      total++;
    }

    if (total === 0) {
      return { dominant: "unknown", consistency: 0, counts };
    }

    const dominant = pickDominant(counts);
    const consistency = counts[dominant] / total;

    return { dominant, consistency, counts };
  }

  private detectColocation(node: DirectoryNode, _tree: DirectoryTree): ColocationResult {
    // Collect source file baseNames
    const sourceBaseNames = new Set<string>();
    for (const filePath of node.files) {
      if (isSourceFile(filePath)) {
        sourceBaseNames.add(getBaseName(filePath));
      }
    }

    const coLocatedTests: string[] = [];
    const coLocatedStyles: string[] = [];
    const coLocatedStories: string[] = [];

    for (const filePath of node.files) {
      const baseName = getBaseName(filePath);

      if (isTestFile(filePath) && sourceBaseNames.has(baseName)) {
        coLocatedTests.push(filePath);
      }
      if (isStyleFile(filePath) && sourceBaseNames.has(baseName)) {
        coLocatedStyles.push(filePath);
      }
      if (isStoryFile(filePath) && sourceBaseNames.has(baseName)) {
        coLocatedStories.push(filePath);
      }
    }

    coLocatedTests.sort(compare);
    coLocatedStyles.sort(compare);
    coLocatedStories.sort(compare);

    return { coLocatedTests, coLocatedStyles, coLocatedStories };
  }

  private detectBarrel(
    node: DirectoryNode,
    _tree: DirectoryTree,
    importData: ImportDataIndex,
  ): BarrelResult {
    if (importData.available) {
      // Check if any direct child is a barrel (confirmed by ImportAnalyzer)
      for (const filePath of node.files) {
        if (importData.barrelFiles.has(filePath)) {
          return { hasBarrel: true, barrelFile: filePath, fromImportAnalyzer: true };
        }
      }
      return { hasBarrel: false, barrelFile: null, fromImportAnalyzer: false };
    }

    // Fallback: filename heuristic
    for (const filePath of node.files) {
      if (isIndexFile(filePath)) {
        return { hasBarrel: true, barrelFile: filePath, fromImportAnalyzer: false };
      }
    }

    return { hasBarrel: false, barrelFile: null, fromImportAnalyzer: false };
  }

  private detectComponentDir(
    node: DirectoryNode,
    _tree: DirectoryTree,
  ): ComponentDirResult | null {
    if (node.path === ".") return null;

    // Criterion 3: at most 8 files
    if (node.files.length > 8) return null;

    // Criterion 2: at most 2 subdirectories
    if (node.childDirs.length > 2) return null;

    // Criterion 1: exactly one file whose baseName matches directory name
    const dirBaseName = node.name.toLowerCase();
    const primaryCandidates: string[] = [];

    for (const filePath of node.files) {
      if (isTestFile(filePath) || isStoryFile(filePath)) continue;
      const baseName = getBaseName(filePath);
      const ext = getExtension(filePath);
      if (baseName.toLowerCase() === dirBaseName && COMPONENT_EXTENSIONS.has(ext)) {
        primaryCandidates.push(filePath);
      }
    }

    if (primaryCandidates.length !== 1) return null;

    const primaryFile = primaryCandidates[0]!;
    const primaryBaseName = getBaseName(primaryFile);

    let indexFile: string | null = null;
    const testFiles: string[] = [];
    const styleFiles: string[] = [];
    const storyFiles: string[] = [];
    const otherFiles: string[] = [];

    for (const filePath of node.files) {
      if (filePath === primaryFile) continue;

      const baseName = getBaseName(filePath);

      if (isIndexFile(filePath)) {
        indexFile = filePath;
      } else if (isTestFile(filePath) && baseName.toLowerCase() === primaryBaseName.toLowerCase()) {
        testFiles.push(filePath);
      } else if (isStyleFile(filePath) && baseName.toLowerCase() === primaryBaseName.toLowerCase()) {
        styleFiles.push(filePath);
      } else if (isStoryFile(filePath) && baseName.toLowerCase() === primaryBaseName.toLowerCase()) {
        storyFiles.push(filePath);
      } else {
        otherFiles.push(filePath);
      }
    }

    testFiles.sort(compare);
    styleFiles.sort(compare);
    storyFiles.sort(compare);
    otherFiles.sort(compare);

    return { primaryFile, indexFile, testFiles, styleFiles, storyFiles, otherFiles };
  }

  // -----------------------------------------------------------------------
  // Phase 3: Project-wide aggregation
  // -----------------------------------------------------------------------

  private aggregateConventions(
    analyses: readonly DirectoryAnalysis[],
    tree: DirectoryTree,
  ): ProjectConventions {
    // File naming tally (across all directories)
    const fileTally = emptyNamingCounts();
    for (const analysis of analyses) {
      for (const [key, count] of Object.entries(analysis.naming.counts)) {
        fileTally[key as NamingCase] += count;
      }
    }

    // Directory naming tally (all dirs except root)
    const dirTally = emptyNamingCounts();
    for (const analysis of analyses) {
      if (analysis.node.path === ".") continue;
      const dirNaming = classifyNamingCase(analysis.node.name);
      dirTally[dirNaming]++;
    }

    const dominantFileNaming = pickDominant(fileTally);
    const dominantDirNaming = pickDominant(dirTally);

    // Co-location rates
    let relevantDirs = 0;
    let dirsWithCoLocatedTests = 0;
    let dirsWithCoLocatedStyles = 0;
    let dirsWithCoLocatedStories = 0;

    for (const analysis of analyses) {
      const hasSource = analysis.node.files.some(f => isSourceFile(f));
      if (!hasSource) continue;
      relevantDirs++;

      if (analysis.colocation.coLocatedTests.length > 0) dirsWithCoLocatedTests++;
      if (analysis.colocation.coLocatedStyles.length > 0) dirsWithCoLocatedStyles++;
      if (analysis.colocation.coLocatedStories.length > 0) dirsWithCoLocatedStories++;
    }

    const testCoLocationRate = relevantDirs === 0 ? 0 : dirsWithCoLocatedTests / relevantDirs;
    const styleCoLocationRate = relevantDirs === 0 ? 0 : dirsWithCoLocatedStyles / relevantDirs;
    const storyCoLocationRate = relevantDirs === 0 ? 0 : dirsWithCoLocatedStories / relevantDirs;

    // Separate test/style directories
    const separateTestDirs: string[] = [];
    const separateStyleDirs: string[] = [];

    for (const analysis of analyses) {
      if (analysis.role.role === "tests") {
        separateTestDirs.push(analysis.node.path);
      } else if (analysis.node.files.length > 0) {
        const testCount = analysis.node.files.filter(f => isTestFile(f)).length;
        if (testCount / analysis.node.files.length > 0.8) {
          separateTestDirs.push(analysis.node.path);
        }
      }

      if (analysis.role.role === "styles") {
        separateStyleDirs.push(analysis.node.path);
      } else if (analysis.node.files.length > 0) {
        const styleCount = analysis.node.files.filter(f => isStyleFile(f)).length;
        if (styleCount / analysis.node.files.length > 0.8) {
          separateStyleDirs.push(analysis.node.path);
        }
      }
    }

    separateTestDirs.sort(compare);
    separateStyleDirs.sort(compare);

    // Barrel + component dir counts
    let barrelCount = 0;
    let componentDirCount = 0;

    for (const analysis of analyses) {
      if (analysis.barrel.hasBarrel) barrelCount++;
      if (analysis.componentDir !== null) componentDirCount++;
    }

    // Depth stats
    let maxDepth = 0;
    let totalDepth = 0;

    for (const analysis of analyses) {
      if (analysis.node.depth > maxDepth) maxDepth = analysis.node.depth;
      totalDepth += analysis.node.depth;
    }

    const totalDirectories = analyses.length;
    const averageDepth = totalDirectories === 0
      ? 0
      : Math.round((totalDepth / totalDirectories) * 10) / 10;

    return {
      dominantFileNaming,
      dominantDirNaming,
      fileTally,
      dirTally,
      testStrategy: computeStrategy(testCoLocationRate),
      testCoLocationRate: Math.round(testCoLocationRate * 100) / 100,
      styleStrategy: computeStrategy(styleCoLocationRate),
      styleCoLocationRate: Math.round(styleCoLocationRate * 100) / 100,
      storyStrategy: computeStrategy(storyCoLocationRate),
      storyCoLocationRate: Math.round(storyCoLocationRate * 100) / 100,
      separateTestDirs,
      separateStyleDirs,
      barrelCount,
      componentDirCount,
      averageDepth,
      maxDepth,
      totalDirectories,
      totalFiles: tree.filesByPath.size,
    };
  }

  // -----------------------------------------------------------------------
  // Phase 4: Output construction
  // -----------------------------------------------------------------------

  private buildDirectoryPattern(analysis: DirectoryAnalysis): PatternResult {
    const { node, role, naming, colocation, barrel, componentDir, extensions } = analysis;
    const isRoot = node.path === ".";

    let confidence: ConfidenceScore;

    if (isRoot) {
      confidence = {
        value: 1.0,
        source: "file-structure-analysis",
        factors: [{ name: "is-root", weight: 1.0, score: 1.0 }],
      };
    } else if (componentDir !== null) {
      const fileCountScore = node.files.length <= 5 ? 1.0 : 0.7;
      confidence = {
        value: 0.5 * 1.0 + 0.3 * 1.0 + 0.2 * fileCountScore,
        source: "file-structure-analysis",
        factors: [
          { name: "name-matches-dir", weight: 0.5, score: 1.0 },
          { name: "has-component-ext", weight: 0.3, score: 1.0 },
          { name: "file-count-reasonable", weight: 0.2, score: fileCountScore },
        ],
      };
    } else {
      const depthScore = node.depth === 0 ? 1.0 : node.depth === 1 ? 0.5 : 0.6;
      confidence = {
        value: role.nameScore * 0.6 + role.contentScore * 0.25 + depthScore * 0.15,
        source: "file-structure-analysis",
        factors: [
          { name: "dir-name-match", weight: 0.6, score: role.nameScore },
          { name: "file-content-signal", weight: 0.25, score: role.contentScore },
          { name: "depth-heuristic", weight: 0.15, score: depthScore },
        ],
      };
    }

    return {
      id: `${node.path}:directory:1` as PatternId,
      type: "utility",
      name: "directory",
      filePath: node.path,
      location: {
        file: node.path,
        start: { line: 1, column: 0 },
        end: { line: 1, column: 0 },
      },
      confidence,
      framework: "unknown",
      dependencies: [],
      properties: {},
      metadata: {
        role: role.role,
        roleScore: Math.round(role.score * 100) / 100,
        fileCount: node.files.length,
        childDirCount: node.childDirs.length,
        depth: node.depth,
        parent: node.parent,
        childDirs: node.childDirs,
        namingConvention: naming.dominant,
        hasBarrel: barrel.hasBarrel,
        barrelFile: barrel.barrelFile,
        isComponentDir: componentDir !== null,
        componentDirInfo: componentDir !== null
          ? {
              primaryFile: componentDir.primaryFile,
              indexFile: componentDir.indexFile,
              testFiles: componentDir.testFiles,
              styleFiles: componentDir.styleFiles,
              storyFiles: componentDir.storyFiles,
              otherFiles: componentDir.otherFiles,
            }
          : null,
        coLocatedTests: colocation.coLocatedTests,
        coLocatedStyles: colocation.coLocatedStyles,
        coLocatedStories: colocation.coLocatedStories,
        extensions,
      },
    };
  }

  private buildConventionsPattern(
    conventions: ProjectConventions,
    fileCount: number,
  ): PatternResult {
    const totalNamingFiles = Object.values(conventions.fileTally).reduce((a, b) => a + b, 0);
    const dominantCount = totalNamingFiles > 0
      ? conventions.fileTally[conventions.dominantFileNaming]
      : 0;
    const sampleScore = Math.min(1.0, fileCount / 20);
    const consistencyScore = totalNamingFiles > 0 ? dominantCount / totalNamingFiles : 0;

    return {
      id: ".:conventions:1" as PatternId,
      type: "utility",
      name: "conventions",
      filePath: ".",
      location: {
        file: ".",
        start: { line: 1, column: 0 },
        end: { line: 1, column: 0 },
      },
      confidence: {
        value: sampleScore * 0.5 + consistencyScore * 0.5,
        source: "file-structure-analysis",
        factors: [
          { name: "sample-size", weight: 0.5, score: sampleScore },
          { name: "consistency", weight: 0.5, score: consistencyScore },
        ],
      },
      framework: "unknown",
      dependencies: [],
      properties: {},
      metadata: {
        dominantFileNaming: conventions.dominantFileNaming,
        dominantDirNaming: conventions.dominantDirNaming,
        fileTally: conventions.fileTally,
        dirTally: conventions.dirTally,
        testStrategy: conventions.testStrategy,
        testCoLocationRate: conventions.testCoLocationRate,
        styleStrategy: conventions.styleStrategy,
        styleCoLocationRate: conventions.styleCoLocationRate,
        storyStrategy: conventions.storyStrategy,
        storyCoLocationRate: conventions.storyCoLocationRate,
        separateTestDirs: conventions.separateTestDirs,
        separateStyleDirs: conventions.separateStyleDirs,
        barrelCount: conventions.barrelCount,
        componentDirCount: conventions.componentDirCount,
        averageDepth: conventions.averageDepth,
        maxDepth: conventions.maxDepth,
        totalDirectories: conventions.totalDirectories,
        totalFiles: conventions.totalFiles,
      },
    };
  }
}
