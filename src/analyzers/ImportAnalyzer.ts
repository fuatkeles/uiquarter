import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type SourceFile,
} from "ts-morph";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerDiagnostic,
  AnalyzerId,
  AnalyzerOutput,
  CacheKey,
  DiscoveredFile,
  PatternId,
  PatternResult,
} from "../types/index.js";
import { compare, stableStringify } from "../core/utils.js";
import { computeEmptyHash } from "./shared.js";

const IMPORT_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);
const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;
const DYNAMIC_SPECIFIER = "<dynamic>";
const BARREL_NAME = "module";

const NODE_BUILTINS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map(stripNodePrefix),
]);

type ImportSpecifierKind = "default" | "named" | "namespace" | "side-effect";
type ImportStatementKind = "es-static" | "es-dynamic" | "require" | "re-export";
type ModuleOrigin = "internal" | "external";

interface ImportedSymbol {
  readonly name: string;
  readonly alias?: string;
  readonly kind: ImportSpecifierKind;
}

interface ImportInfo {
  readonly specifier: string;
  readonly statementKind: ImportStatementKind;
  readonly symbols: readonly ImportedSymbol[];
  readonly line: number;
  readonly column: number;
  readonly isTypeOnly: boolean;
}

interface FileDiagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

interface FileModuleInfo {
  readonly filePath: string;
  readonly imports: readonly ImportInfo[];
  readonly resolvedInternals: Readonly<Record<string, string>>;
  readonly externalPackages: readonly string[];
  readonly isBarrel: boolean;
  readonly hasDynamicImports: boolean;
  readonly hasRequireCalls: boolean;
  readonly diagnostics: readonly FileDiagnostic[];
}

type FileResolutionMap = Map<string, DiscoveredFile>;

interface PathAliasConfig {
  readonly baseUrl: string;
  readonly paths: Readonly<Record<string, readonly string[]>>;
}

interface PackageDependencies {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

interface ImportMetadataEntry {
  readonly specifier: string;
  readonly statementKind: ImportStatementKind;
  readonly symbols: readonly ImportedSymbol[];
  readonly isTypeOnly: boolean;
  readonly line: number;
  readonly resolvedPath?: string;
}

interface ReExportMetadataEntry {
  readonly specifier: string;
  readonly symbols: readonly ImportedSymbol[];
  readonly resolvedPath?: string;
}

const EMPTY_DEPS: PackageDependencies = {
  dependencies: {},
  devDependencies: {},
  peerDependencies: {},
};

export class ImportAnalyzer implements Analyzer {
  readonly name = "import";
  readonly version = "1.0.0";
  readonly capabilities = [
    "import-resolution",
    "dependency-graph",
    "package-detection",
  ] as const;

  private project: Project | null = null;
  private transientFileDiagnostics: FileDiagnostic[] = [];
  private runDiagnostics: AnalyzerDiagnostic[] = [];

  fileFilter(file: DiscoveredFile): boolean {
    return IMPORT_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    this.runDiagnostics = [];

    const fileMap = this.buildFileMap(context.files);
    const aliases = await this.loadPathAliases(context.rootPath);
    const packageDeps = await this.loadPackageDependencies(context.rootPath);
    const knownPackages = this.createKnownPackageSet(packageDeps);

    let cacheHits = 0;
    let cacheMisses = 0;
    const fileInfos: FileModuleInfo[] = [];

    for (const file of context.files) {
      if (context.signal?.aborted === true) break;

      const key = `file:${file.relativePath}` as CacheKey;
      const cached = context.cache.get<FileModuleInfo>(key);

      if (cached !== undefined && cached.inputHash === file.hash) {
        fileInfos.push(cached.value);
        cacheHits += 1;
        continue;
      }

      const info = await this.analyzeFile(file, context.rootPath, aliases);
      context.cache.set(key, info, file.hash);
      fileInfos.push(info);
      cacheMisses += 1;
    }

    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [...this.runDiagnostics];

    for (const info of fileInfos) {
      for (const d of info.diagnostics) {
        diagnostics.push(this.toAnalyzerDiagnostic(info.filePath, d));
      }

      if (info.imports.length === 0) {
        continue;
      }

      const dependencies = new Set<PatternId>();
      const resolvedInternals: Record<string, string> = {};
      const unresolvedSpecifiers = new Set<string>();
      const missingPackages = new Set<string>();

      for (const imp of info.imports) {
        if (imp.specifier === DYNAMIC_SPECIFIER) continue;

        if (this.classifySpecifier(imp.specifier, aliases) === "internal") {
          const resolved = this.resolveSpecifier(
            imp.specifier,
            info.filePath,
            fileMap,
            aliases,
          );

          if (resolved !== null) {
            resolvedInternals[imp.specifier] = resolved;
            dependencies.add(`${resolved}:${BARREL_NAME}:1` as PatternId);
          } else if (!unresolvedSpecifiers.has(imp.specifier)) {
            unresolvedSpecifiers.add(imp.specifier);

            const message = this.isPathAliasSpecifier(imp.specifier, aliases)
              ? `IMP007 Path alias resolved to non-existent file: "${imp.specifier}"`
              : `IMP001 Unresolved internal import: "${imp.specifier}"`;

            diagnostics.push({
              severity: "warning",
              filePath: info.filePath,
              message,
              line: imp.line,
              column: imp.column,
            });
          }
          continue;
        }

        const packageName = extractPackageName(imp.specifier);
        if (
          packageName !== null &&
          !isNodeBuiltin(packageName) &&
          !knownPackages.has(packageName) &&
          !missingPackages.has(packageName)
        ) {
          missingPackages.add(packageName);
          diagnostics.push({
            severity: "warning",
            filePath: info.filePath,
            message: `IMP002 External package "${packageName}" not found in package.json`,
            line: imp.line,
            column: imp.column,
          });
        }
      }

      const enrichedInfo: FileModuleInfo = {
        ...info,
        resolvedInternals: sortRecord(resolvedInternals),
      };

      const pattern: PatternResult = {
        id: `${info.filePath}:${BARREL_NAME}:1` as PatternId,
        type: "utility",
        name: BARREL_NAME,
        filePath: info.filePath,
        location: {
          file: info.filePath,
          start: { line: 1, column: 0 },
          end: { line: 1, column: 0 },
        },
        confidence: {
          value: 1,
          source: "import-analysis",
          factors: [{ name: "ast-parsed", weight: 1, score: 1 }],
        },
        framework: "unknown",
        dependencies: [...dependencies].sort((a, b) =>
          compare(a as string, b as string)),
        properties: {},
        metadata: this.buildMetadata(enrichedInfo, fileMap, aliases),
      };

      patterns.push(pattern);
    }

    patterns.sort((a, b) => compare(a.id as string, b.id as string));
    diagnostics.sort(compareDiagnostics);

    const hash = patterns.length === 0 && diagnostics.length === 0
      ? computeEmptyHash()
      : createHash("sha256")
        .update(stableStringify({ patterns, diagnostics }))
        .digest("hex");

    return {
      analyzerId: `${this.name}@${this.version}` as AnalyzerId,
      patterns,
      diagnostics,
      hash: hash as AnalyzerOutput["hash"],
      duration: Date.now() - start,
      stats: {
        totalFiles: context.files.length,
        analyzedFiles: patterns.length,
        cacheHits,
        cacheMisses,
      },
    };
  }

  private ensureProject(): void {
    if (this.project !== null) return;

    this.project = new Project({
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.React,
        allowJs: true,
      },
      useInMemoryFileSystem: true,
      skipFileDependencyResolution: true,
    });
  }

  private buildFileMap(files: readonly DiscoveredFile[]): FileResolutionMap {
    const map: FileResolutionMap = new Map();
    const sortedFiles = [...files]
      .sort((a, b) =>
        compare(normalizeToPosix(a.relativePath), normalizeToPosix(b.relativePath)));

    for (const file of sortedFiles) {
      const relativePath = normalizeToPosix(file.relativePath);
      const withoutExt = stripKnownExtension(relativePath);

      addFileMapEntry(map, relativePath, file);
      addFileMapEntry(map, withoutExt, file);

      if (withoutExt.endsWith("/index")) {
        const asDir = withoutExt.slice(0, -"/index".length);
        if (asDir.length > 0) addFileMapEntry(map, asDir, file);
      }
    }

    return map;
  }

  private async loadPathAliases(rootPath: string): Promise<PathAliasConfig | null> {
    const tsconfigPath = join(rootPath, "tsconfig.json");

    try {
      const raw = await readFile(tsconfigPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return null;

      const compilerOptions = parsed["compilerOptions"];
      if (!isRecord(compilerOptions)) return null;

      const pathsValue = compilerOptions["paths"];
      if (!isRecord(pathsValue)) return null;

      const baseUrlRaw = compilerOptions["baseUrl"];
      const baseUrl = typeof baseUrlRaw === "string" ? baseUrlRaw : ".";

      const paths: Record<string, readonly string[]> = {};

      for (const key of Object.keys(pathsValue).sort(compare)) {
        const targets = pathsValue[key];
        if (!Array.isArray(targets)) continue;

        const normalizedTargets = targets
          .filter((v): v is string => typeof v === "string")
          .map((v) => normalizeToPosix(v))
          .sort(compare);

        if (normalizedTargets.length > 0) {
          paths[key] = normalizedTargets;
        }
      }

      if (Object.keys(paths).length === 0) return null;

      return {
        baseUrl: normalizeBaseUrl(baseUrl),
        paths,
      };
    } catch (err) {
      if (!isEnoent(err)) {
        this.runDiagnostics.push({
          severity: "warning",
          filePath: "tsconfig.json",
          message: "IMP009 Could not read tsconfig.json",
          line: 1,
          column: 0,
        });
      }
      return null;
    }
  }

  private async loadPackageDependencies(rootPath: string): Promise<PackageDependencies> {
    const packagePath = join(rootPath, "package.json");

    try {
      const raw = await readFile(packagePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return EMPTY_DEPS;

      return {
        dependencies: readDependencyRecord(parsed["dependencies"]),
        devDependencies: readDependencyRecord(parsed["devDependencies"]),
        peerDependencies: readDependencyRecord(parsed["peerDependencies"]),
      };
    } catch (err) {
      if (!isEnoent(err)) {
        this.runDiagnostics.push({
          severity: "warning",
          filePath: "package.json",
          message: "IMP010 Could not read package.json",
          line: 1,
          column: 0,
        });
      }
      return EMPTY_DEPS;
    }
  }

  private async analyzeFile(
    file: DiscoveredFile,
    _rootPath: string,
    aliases: PathAliasConfig | null,
  ): Promise<FileModuleInfo> {
    const filePath = normalizeToPosix(file.relativePath);

    try {
      const source = await readFile(file.absolutePath, "utf-8");
      this.ensureProject();
      this.transientFileDiagnostics = [];

      const sourceFilePath = `/uiquarter/${filePath}`;
      const sourceFile = this.project!.createSourceFile(sourceFilePath, source, {
        overwrite: true,
      });

      try {
        const staticImports = this.extractStaticImports(sourceFile);
        const dynamicImports = this.extractDynamicImports(sourceFile);
        const requireCalls = this.extractRequireCalls(sourceFile);
        const reExports = this.extractReExports(sourceFile);

        const imports = [
          ...staticImports,
          ...dynamicImports,
          ...requireCalls,
          ...reExports,
        ].sort(compareImportInfo);

        const externalPackages = new Set<string>();

        for (const imp of imports) {
          if (imp.specifier === DYNAMIC_SPECIFIER) continue;
          if (this.classifySpecifier(imp.specifier, aliases) === "internal") continue;

          const pkg = extractPackageName(imp.specifier);
          if (pkg !== null && !isNodeBuiltin(pkg)) {
            externalPackages.add(pkg);
          }
        }

        const totalStatements = sourceFile.getStatements().length;
        const reExportCount = reExports.length;
        const isBarrel = totalStatements > 0 &&
          (reExportCount / totalStatements) > 0.5;

        if (isBarrel) {
          this.pushFileDiagnostic(
            "info",
            `IMP006 Barrel file detected: ${reExportCount} re-exports`,
            1,
            0,
          );
        }

        return {
          filePath,
          imports,
          resolvedInternals: {},
          externalPackages: [...externalPackages].sort(compare),
          isBarrel,
          hasDynamicImports: dynamicImports.length > 0,
          hasRequireCalls: requireCalls.length > 0,
          diagnostics: [...this.transientFileDiagnostics].sort(compareFileDiagnostics),
        };
      } finally {
        sourceFile.forget();
      }
    } catch (err) {
      if (isEnoent(err)) {
        return {
          filePath,
          imports: [],
          resolvedInternals: {},
          externalPackages: [],
          isBarrel: false,
          hasDynamicImports: false,
          hasRequireCalls: false,
          diagnostics: [],
        };
      }

      return {
        filePath,
        imports: [],
        resolvedInternals: {},
        externalPackages: [],
        isBarrel: false,
        hasDynamicImports: false,
        hasRequireCalls: false,
        diagnostics: [{
          severity: "warning",
          message: `IMP005 Could not parse file: ${errorMessage(err)}`,
          line: 1,
          column: 0,
        }],
      };
    }
  }

  private extractStaticImports(sourceFile: SourceFile): ImportInfo[] {
    const results: ImportInfo[] = [];

    for (const decl of sourceFile.getImportDeclarations()) {
      const { line, column } = getLineAndColumn(decl);
      const symbols: ImportedSymbol[] = [];

      const defaultImport = decl.getDefaultImport();
      if (defaultImport !== undefined) {
        symbols.push({
          name: "default",
          alias: defaultImport.getText(),
          kind: "default",
        });
      }

      const namespaceImport = decl.getNamespaceImport();
      if (namespaceImport !== undefined) {
        symbols.push({
          name: "*",
          alias: namespaceImport.getText(),
          kind: "namespace",
        });
      }

      const namedImports = decl.getNamedImports();
      let allNamedTypeOnly = namedImports.length > 0;

      for (const namedImport of namedImports) {
        if (!namedImport.isTypeOnly()) {
          allNamedTypeOnly = false;
        }
        const aliasNode = namedImport.getAliasNode();
        symbols.push({
          name: namedImport.getName(),
          alias: aliasNode?.getText(),
          kind: "named",
        });
      }

      if (symbols.length === 0) {
        symbols.push({ name: "*", kind: "side-effect" });
      }

      symbols.sort(compareImportedSymbols);

      // Type-only: either the whole declaration is type-only, or all named
      // imports are individually type-only with no default/namespace import
      const isTypeOnly = decl.isTypeOnly() ||
        (defaultImport === undefined &&
          namespaceImport === undefined &&
          allNamedTypeOnly);

      results.push({
        specifier: decl.getModuleSpecifierValue(),
        statementKind: "es-static",
        symbols,
        line,
        column,
        isTypeOnly,
      });
    }

    return results;
  }

  private extractDynamicImports(sourceFile: SourceFile): ImportInfo[] {
    const results: ImportInfo[] = [];

    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      if (node.getExpression().getKind() !== SyntaxKind.ImportKeyword) return;

      const { line, column } = getLineAndColumn(node);
      const firstArg = node.getArguments()[0];

      if (
        firstArg !== undefined &&
        (Node.isStringLiteral(firstArg) ||
          Node.isNoSubstitutionTemplateLiteral(firstArg))
      ) {
        results.push({
          specifier: firstArg.getLiteralValue(),
          statementKind: "es-dynamic",
          symbols: [],
          line,
          column,
          isTypeOnly: false,
        });
        return;
      }

      this.pushFileDiagnostic(
        "info",
        `IMP003 Dynamic import with non-literal specifier at line ${line}`,
        line,
        column,
      );

      results.push({
        specifier: DYNAMIC_SPECIFIER,
        statementKind: "es-dynamic",
        symbols: [],
        line,
        column,
        isTypeOnly: false,
      });
    });

    return results;
  }

  private extractRequireCalls(sourceFile: SourceFile): ImportInfo[] {
    const results: ImportInfo[] = [];

    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      if (!isRequireCall(node)) return;

      const { line, column } = getLineAndColumn(node);
      const firstArg = node.getArguments()[0];

      if (
        firstArg !== undefined &&
        (Node.isStringLiteral(firstArg) ||
          Node.isNoSubstitutionTemplateLiteral(firstArg))
      ) {
        results.push({
          specifier: firstArg.getLiteralValue(),
          statementKind: "require",
          symbols: [],
          line,
          column,
          isTypeOnly: false,
        });
        return;
      }

      this.pushFileDiagnostic(
        "info",
        `IMP004 require() with non-literal specifier at line ${line}`,
        line,
        column,
      );

      results.push({
        specifier: DYNAMIC_SPECIFIER,
        statementKind: "require",
        symbols: [],
        line,
        column,
        isTypeOnly: false,
      });
    });

    return results;
  }

  private extractReExports(sourceFile: SourceFile): ImportInfo[] {
    const results: ImportInfo[] = [];

    for (const decl of sourceFile.getExportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue();
      if (specifier === undefined) continue;

      const { line, column } = getLineAndColumn(decl);
      const symbols: ImportedSymbol[] = [];

      const namespaceExport = decl.getNamespaceExport();
      if (namespaceExport !== undefined) {
        symbols.push({
          name: "*",
          alias: namespaceExport.getText(),
          kind: "namespace",
        });
      }

      const namedExports = decl.getNamedExports();
      let allNamedTypeOnly = namedExports.length > 0;

      for (const namedExport of namedExports) {
        if (!namedExport.isTypeOnly()) {
          allNamedTypeOnly = false;
        }
        const aliasNode = namedExport.getAliasNode();
        symbols.push({
          name: namedExport.getName(),
          alias: aliasNode?.getText(),
          kind: "named",
        });
      }

      if (symbols.length === 0) {
        symbols.push({ name: "*", kind: "namespace" });
      }

      symbols.sort(compareImportedSymbols);

      // Type-only: either the whole declaration is type-only, or all named
      // exports are individually type-only with no namespace export
      const isTypeOnly = decl.isTypeOnly() ||
        (namespaceExport === undefined && allNamedTypeOnly);

      results.push({
        specifier,
        statementKind: "re-export",
        symbols,
        line,
        column,
        isTypeOnly,
      });
    }

    return results;
  }

  private resolveSpecifier(
    specifier: string,
    importerPath: string,
    fileMap: FileResolutionMap,
    aliases: PathAliasConfig | null,
  ): string | null {
    if (specifier === DYNAMIC_SPECIFIER) return null;

    if (this.isPathAliasSpecifier(specifier, aliases)) {
      const aliasCandidates = this.resolveAliasCandidates(specifier, aliases);
      for (const candidate of aliasCandidates) {
        const resolved = this.tryResolveCandidate(candidate, fileMap);
        if (resolved !== null) return resolved;
      }
      return null;
    }

    if (!(specifier.startsWith("./") || specifier.startsWith("../"))) {
      return null;
    }

    const importerDir = posix.dirname(normalizeToPosix(importerPath));
    const relativeTarget = normalizeToPosix(
      posix.normalize(posix.join(importerDir, specifier)),
    );

    return this.tryResolveCandidate(relativeTarget, fileMap);
  }

  private buildMetadata(
    info: FileModuleInfo,
    _fileMap: FileResolutionMap,
    aliases: PathAliasConfig | null,
  ): Record<string, unknown> {
    const internalImports = sortedUnique(
      info.imports
        .filter((imp) =>
          imp.specifier !== DYNAMIC_SPECIFIER &&
          this.classifySpecifier(imp.specifier, aliases) === "internal")
        .map((imp) => imp.specifier),
    );

    const imports: ImportMetadataEntry[] = info.imports
      .map((imp) => {
        const resolvedPath = info.resolvedInternals[imp.specifier];
        return {
          specifier: imp.specifier,
          statementKind: imp.statementKind,
          symbols: [...imp.symbols].sort(compareImportedSymbols),
          isTypeOnly: imp.isTypeOnly,
          line: imp.line,
          ...(resolvedPath !== undefined ? { resolvedPath } : {}),
        };
      })
      .sort(compareImportMetadata);

    const reExports: ReExportMetadataEntry[] = imports
      .filter((entry) => entry.statementKind === "re-export")
      .map((entry) => ({
        specifier: entry.specifier,
        symbols: entry.symbols,
        ...(entry.resolvedPath !== undefined
          ? { resolvedPath: entry.resolvedPath }
          : {}),
      }))
      .sort(compareReExportMetadata);

    return {
      importCount: info.imports.length,
      externalPackages: sortedUnique(info.externalPackages),
      internalImports,
      isBarrel: info.isBarrel,
      hasDynamicImports: info.hasDynamicImports,
      hasRequireCalls: info.hasRequireCalls,
      hasTypeOnlyImports: info.imports.some((imp) => imp.isTypeOnly),
      imports,
      reExports,
    };
  }

  private classifySpecifier(
    specifier: string,
    aliases: PathAliasConfig | null,
  ): ModuleOrigin {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      return "internal";
    }

    if (this.isPathAliasSpecifier(specifier, aliases)) {
      return "internal";
    }

    return "external";
  }

  private isPathAliasSpecifier(
    specifier: string,
    aliases: PathAliasConfig | null,
  ): boolean {
    return this.resolveAliasCandidates(specifier, aliases).length > 0;
  }

  private resolveAliasCandidates(
    specifier: string,
    aliases: PathAliasConfig | null,
  ): string[] {
    if (aliases === null) return [];

    const candidates: string[] = [];
    const entries = Object.entries(aliases.paths)
      .sort((a, b) => b[0].length - a[0].length || compare(a[0], b[0]));

    for (const [pattern, targets] of entries) {
      const wildcard = matchAliasPattern(specifier, pattern);
      if (wildcard === null) continue;

      for (const target of targets) {
        const resolvedTarget = pattern.includes("*")
          ? target.replace("*", wildcard)
          : target;
        const withBase = aliases.baseUrl.length > 0
          ? posix.join(aliases.baseUrl, resolvedTarget)
          : resolvedTarget;
        candidates.push(normalizeToPosix(withBase));
      }
    }

    return sortedUnique(candidates);
  }

  private tryResolveCandidate(
    candidatePath: string,
    fileMap: FileResolutionMap,
  ): string | null {
    const normalized = normalizeToPosix(candidatePath);
    if (normalized.length === 0) return null;

    const base = stripKnownExtension(normalized).replace(/\/+$/, "");

    // 1. Exact match — only when specifier has a known extension
    if (normalized !== base) {
      const exact = fileMap.get(normalized);
      if (exact !== undefined) return normalizeToPosix(exact.relativePath);
    }

    // 2. Try extensions in TypeScript resolution order (.ts > .tsx > .js > .jsx)
    for (const ext of RESOLUTION_EXTENSIONS) {
      const file = fileMap.get(`${base}${ext}`);
      if (file !== undefined) return normalizeToPosix(file.relativePath);
    }

    // 3. Try index files in TypeScript resolution order
    for (const ext of RESOLUTION_EXTENSIONS) {
      const file = fileMap.get(`${base}/index${ext}`);
      if (file !== undefined) return normalizeToPosix(file.relativePath);
    }

    // 4. Fallback: extensionless key (catches non-standard extensions)
    const baseFile = fileMap.get(normalized);
    if (baseFile !== undefined) return normalizeToPosix(baseFile.relativePath);

    // 5. Fallback: directory index without extension
    const indexFile = fileMap.get(`${base}/index`);
    if (indexFile !== undefined) return normalizeToPosix(indexFile.relativePath);

    return null;
  }

  private toAnalyzerDiagnostic(
    filePath: string,
    diagnostic: FileDiagnostic,
  ): AnalyzerDiagnostic {
    return {
      severity: diagnostic.severity,
      filePath,
      message: diagnostic.message,
      line: diagnostic.line,
      column: diagnostic.column,
    };
  }

  private createKnownPackageSet(packageDeps: PackageDependencies): Set<string> {
    return new Set<string>([
      ...Object.keys(packageDeps.dependencies),
      ...Object.keys(packageDeps.devDependencies),
      ...Object.keys(packageDeps.peerDependencies),
    ]);
  }

  private pushFileDiagnostic(
    severity: FileDiagnostic["severity"],
    message: string,
    line: number,
    column: number,
  ): void {
    this.transientFileDiagnostics.push({
      severity,
      message,
      line,
      column,
    });
  }
}

function isRequireCall(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const expression = node.getExpression();
  return Node.isIdentifier(expression) && expression.getText() === "require";
}

function compareDiagnostics(a: AnalyzerDiagnostic, b: AnalyzerDiagnostic): number {
  return compare(a.filePath, b.filePath) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    compare(a.severity, b.severity) ||
    compare(a.message, b.message);
}

function compareFileDiagnostics(a: FileDiagnostic, b: FileDiagnostic): number {
  return a.line - b.line ||
    a.column - b.column ||
    compare(a.severity, b.severity) ||
    compare(a.message, b.message);
}

function compareImportInfo(a: ImportInfo, b: ImportInfo): number {
  return a.line - b.line ||
    a.column - b.column ||
    compare(a.statementKind, b.statementKind) ||
    compare(a.specifier, b.specifier);
}

function compareImportedSymbols(a: ImportedSymbol, b: ImportedSymbol): number {
  return compare(a.kind, b.kind) ||
    compare(a.name, b.name) ||
    compare(a.alias ?? "", b.alias ?? "");
}

function compareImportMetadata(a: ImportMetadataEntry, b: ImportMetadataEntry): number {
  return a.line - b.line ||
    compare(a.statementKind, b.statementKind) ||
    compare(a.specifier, b.specifier);
}

function compareReExportMetadata(
  a: ReExportMetadataEntry,
  b: ReExportMetadataEntry,
): number {
  return compare(a.specifier, b.specifier);
}

function extractPackageName(specifier: string): string | null {
  if (
    specifier.length === 0 ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/")
  ) {
    return null;
  }

  const normalized = stripNodePrefix(specifier);
  const segments = normalized.split("/").filter((p) => p.length > 0);
  if (segments.length === 0) return null;

  if (segments[0]!.startsWith("@")) {
    if (segments.length < 2) return segments[0]!;
    return `${segments[0]}/${segments[1]}`;
  }

  return segments[0]!;
}

function isNodeBuiltin(packageName: string): boolean {
  return NODE_BUILTINS.has(packageName) || NODE_BUILTINS.has(stripNodePrefix(packageName));
}

function normalizeToPosix(value: string): string {
  const withForwardSlashes = value.replace(/\\/g, "/");
  const withoutDotPrefix = withForwardSlashes.startsWith("./")
    ? withForwardSlashes.slice(2)
    : withForwardSlashes;
  const normalized = posix.normalize(withoutDotPrefix);
  if (normalized === ".") return "";
  return normalized.replace(/^\/+/, "");
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = normalizeToPosix(baseUrl);
  return normalized === "." ? "" : normalized;
}

function stripKnownExtension(pathLike: string): string {
  for (const ext of RESOLUTION_EXTENSIONS) {
    if (pathLike.endsWith(ext)) {
      return pathLike.slice(0, -ext.length);
    }
  }
  return pathLike;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function addFileMapEntry(
  map: FileResolutionMap,
  key: string,
  file: DiscoveredFile,
): void {
  if (key.length === 0) return;
  if (!map.has(key)) {
    map.set(key, file);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDependencyRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {};

  const result: Record<string, string> = {};
  for (const key of Object.keys(value).sort(compare)) {
    const depVersion = value[key];
    if (typeof depVersion === "string") {
      result[key] = depVersion;
    }
  }
  return result;
}

function getLineAndColumn(node: Node): { line: number; column: number } {
  const pos = node.getStart(false);
  const lineAndColumn = node.getSourceFile().getLineAndColumnAtPos(pos);
  return {
    line: lineAndColumn.line,
    column: Math.max(0, lineAndColumn.column - 1),
  };
}

function matchAliasPattern(specifier: string, pattern: string): string | null {
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex === -1) {
    return specifier === pattern ? "" : null;
  }

  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);

  if (!specifier.startsWith(prefix)) return null;
  if (!specifier.endsWith(suffix)) return null;

  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function sortRecord(input: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(input).sort(compare)) {
    out[key] = input[key]!;
  }
  return out;
}

function isEnoent(err: unknown): boolean {
  return isRecord(err) && err["code"] === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stripNodePrefix(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}
