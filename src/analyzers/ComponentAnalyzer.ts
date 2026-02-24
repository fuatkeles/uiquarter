import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type ArrowFunction,
  type CallExpression,
  type ClassDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type ObjectBindingPattern,
  type SourceFile,
  type TypeNode,
  type VariableDeclaration,
} from "ts-morph";
import { compare, stableStringify } from "../core/utils.js";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerDiagnostic,
  AnalyzerId,
  AnalyzerOutput,
  CacheKey,
  DiscoveredFile,
  PatternId,
  PatternProperty,
  PatternResult,
  PatternType,
} from "../types/index.js";

const COMPONENT_FILTER_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "vue",
  "svelte",
]);

type ComponentKind =
  | "function-declaration"
  | "arrow-function"
  | "function-expression"
  | "class-component"
  | "forwardRef"
  | "memo"
  | "vue-sfc"
  | "svelte-sfc";

type WrapperKind = "memo" | "forwardRef" | "observer" | "connect" | "withRouter";

interface WrapperInfo {
  readonly wrapper: WrapperKind;
  readonly line: number;
}

interface JsxAnalysis {
  readonly hasJsx: boolean;
  readonly childComponentRefs: readonly string[];
  readonly htmlElementCount: number;
  readonly componentElementCount: number;
  readonly hasConditionalRendering: boolean;
  readonly hasListRendering: boolean;
  readonly hasFragments: boolean;
  readonly depth: number;
  readonly providerContextNames: readonly string[];
}

interface HocSignals {
  readonly takesComponentParam: boolean;
  readonly returnsComponent: boolean;
}

interface ComponentDetection {
  readonly name: string;
  readonly exportName: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly kind: ComponentKind;
  readonly isDefaultExport: boolean;
  readonly isNamedExport: boolean;
  readonly hasJsx: boolean;
  readonly props: readonly PatternProperty[];
  readonly jsxAnalysis: JsxAnalysis;
  readonly wrappers: readonly WrapperInfo[];
  readonly hasTypedProps: boolean;
  readonly hasAnyProps: boolean;
  readonly hocSignals: HocSignals;
  readonly contextName: string | null;
}

interface HookParameter {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue?: string;
}

interface HookDetection {
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly isDefaultExport: boolean;
  readonly isNamedExport: boolean;
  readonly hookCalls: readonly string[];
  readonly parameters: readonly HookParameter[];
}

interface FileDiagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

interface FileComponentInfo {
  readonly filePath: string;
  readonly components: readonly ComponentDetection[];
  readonly hooks: readonly HookDetection[];
  readonly diagnostics: readonly FileDiagnostic[];
}

interface ImportDataIndex {
  readonly available: boolean;
  readonly patternsByFile: ReadonlyMap<string, PatternResult>;
}

interface ExportInfo {
  readonly namedExportNames: readonly string[];
  readonly isDefaultExport: boolean;
}

interface TypePropertyInfo {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

interface ImportBinding {
  readonly localName: string;
  readonly importedName: string;
  readonly kind: "default" | "named" | "namespace" | "side-effect";
  readonly resolvedPath: string;
}

type ComponentFunctionLike =
  | FunctionDeclaration
  | ArrowFunction
  | FunctionExpression;

interface WrapperUnwrapResult {
  readonly node: Node;
  readonly wrappers: readonly WrapperInfo[];
}

interface TargetPatternIndex {
  readonly byFile: ReadonlyMap<string, {
    readonly all: readonly PatternResult[];
    readonly byName: ReadonlyMap<string, PatternResult>;
    readonly byExportName: ReadonlyMap<string, PatternResult>;
    readonly defaultPattern: PatternResult | null;
  }>;
}

const KNOWN_WRAPPERS = new Set<WrapperKind>([
  "memo",
  "forwardRef",
  "observer",
  "connect",
  "withRouter",
]);

const REACT_FRAMEWORK_PACKAGES = new Set([
  "react",
  "react-dom",
  "next",
  "remix",
  "gatsby",
]);

const ANGULAR_PREFIX = "@angular/";

const HOOK_CALL_ALLOWLIST = new Set([
  "useState",
  "useEffect",
  "useRef",
  "useMemo",
  "useCallback",
  "useContext",
]);

export class ComponentAnalyzer implements Analyzer {
  readonly name = "component";
  readonly version = "1.0.0";
  readonly capabilities = [
    "component-detection",
    "prop-extraction",
    "hook-detection",
    "hoc-detection",
    "context-provider-detection",
    "jsx-analysis",
    "forwardRef-detection",
    "memo-detection",
  ] as const;
  readonly dependencies = ["import"] as const;

  private project: Project | null = null;
  private transientDiagnostics: FileDiagnostic[] = [];
  private runDiagnostics: AnalyzerDiagnostic[] = [];
  private currentImportIndex: ImportDataIndex | null = null;
  private currentTargetPatternIndex: TargetPatternIndex = { byFile: new Map() };

  fileFilter(file: DiscoveredFile): boolean {
    return COMPONENT_FILTER_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const startedAt = Date.now();
    this.runDiagnostics = [];

    const sortedFiles = [...context.files].sort((a, b) =>
      compare(normalizeToPosix(a.relativePath), normalizeToPosix(b.relativePath)));

    const importIndex = this.buildImportDataIndex(context);
    this.currentImportIndex = importIndex;

    let cacheHits = 0;
    let cacheMisses = 0;
    const fileInfos: FileComponentInfo[] = [];

    for (const file of sortedFiles) {
      if (context.signal?.aborted === true) break;

      const key = `file:${file.relativePath}` as CacheKey;
      const cached = context.cache.get<FileComponentInfo>(key);

      if (cached !== undefined && cached.inputHash === file.hash) {
        fileInfos.push(cached.value);
        cacheHits += 1;
        continue;
      }

      const info = await this.analyzeFile(file);
      context.cache.set(key, info, file.hash);
      fileInfos.push(info);
      cacheMisses += 1;
    }

    fileInfos.sort((a, b) => compare(a.filePath, b.filePath));

    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [...this.runDiagnostics];

    for (const info of fileInfos) {
      for (const diagnostic of info.diagnostics) {
        diagnostics.push({
          severity: diagnostic.severity,
          filePath: info.filePath,
          message: diagnostic.message,
          line: diagnostic.line,
          column: diagnostic.column,
        });
      }
    }

    this.currentTargetPatternIndex = this.buildTargetPatternIndexFromFileInfos(fileInfos);

    for (const info of fileInfos) {
      for (const component of info.components) {
        patterns.push(this.buildComponentPattern(component, info, importIndex));
      }
      for (const hook of info.hooks) {
        patterns.push(this.buildHookPattern(hook, info, importIndex));
      }
    }

    patterns.sort((a, b) =>
      compare(a.id as string, b.id as string) ||
      compare(a.filePath, b.filePath) ||
      compare(a.name, b.name));

    const patchedPatterns = patterns.map((pattern) => {
      if (pattern.type === "hook") {
        return pattern;
      }
      const patched = this.patchComponentDependencies(pattern);
      return {
        ...pattern,
        dependencies: patched.dependencies,
        metadata: patched.metadata,
      };
    });

    patchedPatterns.sort((a, b) =>
      compare(a.id as string, b.id as string) ||
      compare(a.filePath, b.filePath) ||
      compare(a.name, b.name));

    diagnostics.sort((a, b) =>
      compare(a.filePath, b.filePath) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      compare(a.severity, b.severity) ||
      compare(a.message, b.message));

    const hash = createHash("sha256")
      .update(stableStringify({ patterns: patchedPatterns, diagnostics }))
      .digest("hex");

    return {
      analyzerId: `${this.name}@${this.version}` as AnalyzerId,
      patterns: patchedPatterns,
      diagnostics,
      hash: hash as AnalyzerOutput["hash"],
      duration: Date.now() - startedAt,
      stats: {
        totalFiles: context.files.length,
        analyzedFiles: cacheMisses,
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

  private async analyzeFile(file: DiscoveredFile): Promise<FileComponentInfo> {
    const filePath = normalizeToPosix(file.relativePath);
    const extension = file.extension;
    this.transientDiagnostics = [];

    try {
      const source = await readFile(file.absolutePath, "utf-8");

      if (extension === "vue") {
        return this.analyzeVueFile(filePath, source);
      }

      if (extension === "svelte") {
        return this.analyzeSvelteFile(filePath, source);
      }

      this.ensureProject();
      const sourceFilePath = `/uiquarter/${filePath}`;
      const sourceFile = this.project!.createSourceFile(sourceFilePath, source, {
        overwrite: true,
      });

      try {
        const parseDiagnostics =
          (sourceFile.compilerNode as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
            .parseDiagnostics ?? [];
        const parseDiagnostic = parseDiagnostics[0];
        if (parseDiagnostic !== undefined) {
          const lineAndColumn = parseDiagnostic.start === undefined
            ? { line: 1, column: 0 }
            : toLineAndColumn(sourceFile, parseDiagnostic.start);

          return {
            filePath,
            components: [],
            hooks: [],
            diagnostics: [{
              severity: "warning",
              message: `CMP003 Could not parse file: ${flattenDiagnosticMessage(parseDiagnostic.messageText)}`,
              line: lineAndColumn.line,
              column: lineAndColumn.column,
            }],
          };
        }

        const components = this.detectComponents(sourceFile, filePath);
        const hooks = this.detectHooks(sourceFile, filePath);

        return {
          filePath,
          components: components.sort(compareComponentDetection),
          hooks: hooks.sort(compareHookDetection),
          diagnostics: [...this.transientDiagnostics].sort(compareFileDiagnostic),
        };
      } finally {
        sourceFile.forget();
      }
    } catch (error) {
      return {
        filePath,
        components: [],
        hooks: [],
        diagnostics: [{
          severity: "warning",
          message: `CMP003 Could not parse file: ${errorMessage(error)}`,
          line: 1,
          column: 0,
        }],
      };
    }
  }

  private analyzeVueFile(filePath: string, source: string): FileComponentInfo {
    const componentName = toPascalCase(fileBaseName(filePath));
    const scriptBlock = extractVueScriptBlock(source);
    const props: PatternProperty[] = [];

    if (scriptBlock === null) {
      this.transientDiagnostics.push({
        severity: "info",
        message: "CMP004 No <script> block found in SFC",
        line: 1,
        column: 0,
      });
    } else {
      this.ensureProject();
      const sourceFile = this.project!.createSourceFile(
        `/uiquarter/${filePath}.__vue_script.ts`,
        scriptBlock.content,
        { overwrite: true },
      );

      try {
        const fromDefineProps = this.extractVueDefineProps(sourceFile, componentName);
        if (fromDefineProps.length > 0) {
          props.push(...fromDefineProps);
        } else {
          props.push(...this.extractVueOptionsApiProps(sourceFile, componentName));
        }
      } finally {
        sourceFile.forget();
      }
    }

    const lineCount = source.split(/\r?\n/).length;
    const detection: ComponentDetection = {
      name: componentName,
      exportName: "default",
      line: 1,
      column: 0,
      endLine: Math.max(1, lineCount),
      endColumn: 0,
      kind: "vue-sfc",
      isDefaultExport: true,
      isNamedExport: false,
      hasJsx: false,
      props: props.sort(compareProperty),
      jsxAnalysis: emptyJsxAnalysis(),
      wrappers: [],
      hasTypedProps: props.some((property) => property.type !== "unknown"),
      hasAnyProps: props.length > 0,
      hocSignals: { takesComponentParam: false, returnsComponent: false },
      contextName: null,
    };

    this.transientDiagnostics.push({
      severity: "info",
      message: `CMP001 Component detected: "${detection.name}" (${detection.kind})`,
      line: 1,
      column: 0,
    });

    return {
      filePath,
      components: [detection],
      hooks: [],
      diagnostics: [...this.transientDiagnostics].sort(compareFileDiagnostic),
    };
  }

  private analyzeSvelteFile(filePath: string, source: string): FileComponentInfo {
    const componentName = toPascalCase(fileBaseName(filePath));
    const scriptBlock = extractSvelteScriptBlock(source);
    const props: PatternProperty[] = [];

    if (scriptBlock === null) {
      this.transientDiagnostics.push({
        severity: "info",
        message: "CMP004 No <script> block found in SFC",
        line: 1,
        column: 0,
      });
    } else {
      this.ensureProject();
      const sourceFile = this.project!.createSourceFile(
        `/uiquarter/${filePath}.__svelte_script.ts`,
        scriptBlock.content,
        { overwrite: true },
      );

      try {
        props.push(...this.extractSvelteProps(sourceFile));
      } finally {
        sourceFile.forget();
      }
    }

    const lineCount = source.split(/\r?\n/).length;
    const detection: ComponentDetection = {
      name: componentName,
      exportName: "default",
      line: 1,
      column: 0,
      endLine: Math.max(1, lineCount),
      endColumn: 0,
      kind: "svelte-sfc",
      isDefaultExport: true,
      isNamedExport: false,
      hasJsx: false,
      props: props.sort(compareProperty),
      jsxAnalysis: emptyJsxAnalysis(),
      wrappers: [],
      hasTypedProps: props.some((property) => property.type !== "unknown"),
      hasAnyProps: props.length > 0,
      hocSignals: { takesComponentParam: false, returnsComponent: false },
      contextName: null,
    };

    this.transientDiagnostics.push({
      severity: "info",
      message: `CMP001 Component detected: "${detection.name}" (${detection.kind})`,
      line: 1,
      column: 0,
    });

    return {
      filePath,
      components: [detection],
      hooks: [],
      diagnostics: [...this.transientDiagnostics].sort(compareFileDiagnostic),
    };
  }

  private detectComponents(sourceFile: SourceFile, filePath: string): ComponentDetection[] {
    const detections: ComponentDetection[] = [];
    const exportMap = buildExportInfoMap(sourceFile);

    for (const fn of sourceFile.getFunctions()) {
      if (!isTopLevelDeclaration(fn, sourceFile)) continue;
      const explicitName = fn.getName();
      const fallbackName = toPascalCase(fileBaseName(filePath));
      const candidateName = explicitName ?? fallbackName;
      const hocSignals = this.computeHocSignals(fn, candidateName);
      const jsxAnalysis = this.extractReturnJsx(fn);
      const hasJsx = jsxAnalysis.hasJsx || hocSignals.returnsComponent;
      const wrapperInfo: WrapperInfo[] = [];

      if (!isComponentLikeName(candidateName) && !hocSignals.takesComponentParam) {
        continue;
      }
      if (!hasJsx && !hocSignals.takesComponentParam) {
        continue;
      }

      const exportInfo = mergeExportInfo(
        exportMap.get(candidateName),
        fn.isDefaultExport(),
        fn.hasExportKeyword(),
        candidateName,
      );

      const start = getLineAndColumn(fn);
      const end = getEndLineAndColumn(fn);
      const provisionalDetection: ComponentDetection = {
        name: candidateName,
        exportName: exportInfo.namedExportNames[0] ?? (exportInfo.isDefaultExport ? "default" : candidateName),
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
        kind: "function-declaration",
        isDefaultExport: exportInfo.isDefaultExport,
        isNamedExport: exportInfo.namedExportNames.length > 0,
        hasJsx,
        props: [],
        jsxAnalysis,
        wrappers: wrapperInfo,
        hasTypedProps: false,
        hasAnyProps: false,
        hocSignals,
        contextName: jsxAnalysis.providerContextNames[0] ?? null,
      };

      const extractedProps = this.extractProps(fn, provisionalDetection);

      const detection: ComponentDetection = {
        ...provisionalDetection,
        props: extractedProps.sort(compareProperty),
        hasTypedProps: extractedProps.some((property) => property.type !== "unknown"),
        hasAnyProps: extractedProps.length > 0,
      };

      detections.push(detection);
      this.pushComponentDiagnostics(detection);
    }

    for (const variableStatement of sourceFile.getVariableStatements()) {
      if (!isTopLevelStatement(variableStatement, sourceFile)) continue;
      const hasExportKeyword = variableStatement.hasExportKeyword();
      const isDefaultExport = variableStatement.hasDefaultKeyword();

      for (const declaration of variableStatement.getDeclarations()) {
        const variableName = declaration.getName();
        if (!isComponentLikeName(variableName) && !isHocName(variableName)) {
          continue;
        }

        const initializer = declaration.getInitializer();
        if (initializer === undefined) continue;

        const unwrapResult = unwrapWrappers(initializer);
        const coreNode = unwrapResult.node;
        const wrappers = [...unwrapResult.wrappers].sort(compareWrapperInfo);

        const componentKind = this.detectComponentKind(coreNode, wrappers);
        if (componentKind === null) continue;

        const jsxAnalysis = this.extractReturnJsx(coreNode);
        const hocSignals = this.computeHocSignals(coreNode, variableName);
        const hasJsx = jsxAnalysis.hasJsx || hocSignals.returnsComponent || wrappers.length > 0;

        if (!hasJsx && !hocSignals.takesComponentParam && wrappers.length === 0) {
          continue;
        }

        const exportInfo = mergeExportInfo(
          exportMap.get(variableName),
          isDefaultExport,
          hasExportKeyword,
          variableName,
        );

        const start = getLineAndColumn(declaration);
        const end = getEndLineAndColumn(declaration);

        const provisionalDetection: ComponentDetection = {
          name: variableName,
          exportName: exportInfo.namedExportNames[0] ?? (exportInfo.isDefaultExport ? "default" : variableName),
          line: start.line,
          column: start.column,
          endLine: end.line,
          endColumn: end.column,
          kind: componentKind,
          isDefaultExport: exportInfo.isDefaultExport,
          isNamedExport: exportInfo.namedExportNames.length > 0,
          hasJsx,
          props: [],
          jsxAnalysis,
          wrappers,
          hasTypedProps: false,
          hasAnyProps: false,
          hocSignals,
          contextName: jsxAnalysis.providerContextNames[0] ?? null,
        };

        const extractedProps = this.extractProps(declaration, provisionalDetection);
        const detection: ComponentDetection = {
          ...provisionalDetection,
          props: extractedProps.sort(compareProperty),
          hasTypedProps: extractedProps.some((property) => property.type !== "unknown"),
          hasAnyProps: extractedProps.length > 0,
        };

        detections.push(detection);
        this.pushComponentDiagnostics(detection);
      }
    }

    for (const classDeclaration of sourceFile.getClasses()) {
      if (!isTopLevelDeclaration(classDeclaration, sourceFile)) continue;

      const className = classDeclaration.getName();
      if (className === undefined || !isComponentLikeName(className)) continue;
      if (!isReactClassComponent(classDeclaration)) continue;

      const exportInfo = mergeExportInfo(
        exportMap.get(className),
        classDeclaration.hasDefaultKeyword(),
        classDeclaration.hasExportKeyword(),
        className,
      );

      const renderMethod = classDeclaration.getMethod("render");
      const jsxAnalysis = renderMethod === undefined
        ? emptyJsxAnalysis()
        : this.extractReturnJsx(renderMethod);

      const start = getLineAndColumn(classDeclaration);
      const end = getEndLineAndColumn(classDeclaration);
      const provisionalDetection: ComponentDetection = {
        name: className,
        exportName: exportInfo.namedExportNames[0] ?? (exportInfo.isDefaultExport ? "default" : className),
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
        kind: "class-component",
        isDefaultExport: exportInfo.isDefaultExport,
        isNamedExport: exportInfo.namedExportNames.length > 0,
        hasJsx: jsxAnalysis.hasJsx,
        props: [],
        jsxAnalysis,
        wrappers: [],
        hasTypedProps: false,
        hasAnyProps: false,
        hocSignals: this.computeHocSignals(classDeclaration, className),
        contextName: jsxAnalysis.providerContextNames[0] ?? null,
      };

      const extractedProps = this.extractProps(classDeclaration, provisionalDetection);
      const detection: ComponentDetection = {
        ...provisionalDetection,
        props: extractedProps.sort(compareProperty),
        hasTypedProps: extractedProps.some((property) => property.type !== "unknown"),
        hasAnyProps: extractedProps.length > 0,
      };

      detections.push(detection);
      this.pushComponentDiagnostics(detection);
    }

    for (const exportAssignment of sourceFile.getExportAssignments()) {
      if (exportAssignment.isExportEquals()) continue;
      const expression = exportAssignment.getExpression();
      const unwrapResult = unwrapWrappers(expression);
      const node = unwrapResult.node;

      if (
        !Node.isArrowFunction(node) &&
        !Node.isFunctionExpression(node) &&
        !Node.isFunctionDeclaration(node) &&
        !Node.isClassExpression(node) &&
        !Node.isClassDeclaration(node)
      ) {
        continue;
      }

      const inferredName = toPascalCase(fileBaseName(filePath));
      const jsxAnalysis = this.extractReturnJsx(node);
      const hocSignals = this.computeHocSignals(node, inferredName);
      if (!jsxAnalysis.hasJsx && !hocSignals.takesComponentParam && unwrapResult.wrappers.length === 0) {
        continue;
      }

      const kind = this.detectComponentKind(node, unwrapResult.wrappers);
      if (kind === null) continue;

      const start = getLineAndColumn(expression);
      const end = getEndLineAndColumn(expression);
      const provisionalDetection: ComponentDetection = {
        name: inferredName,
        exportName: "default",
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
        kind,
        isDefaultExport: true,
        isNamedExport: false,
        hasJsx: jsxAnalysis.hasJsx,
        props: [],
        jsxAnalysis,
        wrappers: unwrapResult.wrappers,
        hasTypedProps: false,
        hasAnyProps: false,
        hocSignals,
        contextName: jsxAnalysis.providerContextNames[0] ?? null,
      };

      const extractedProps = this.extractProps(node, provisionalDetection);
      const detection: ComponentDetection = {
        ...provisionalDetection,
        props: extractedProps.sort(compareProperty),
        hasTypedProps: extractedProps.some((property) => property.type !== "unknown"),
        hasAnyProps: extractedProps.length > 0,
      };

      detections.push(detection);
      this.pushComponentDiagnostics(detection);
    }

    return dedupeComponents(detections).sort(compareComponentDetection);
  }

  private detectHooks(sourceFile: SourceFile, _filePath: string): HookDetection[] {
    const detections: HookDetection[] = [];
    const exportMap = buildExportInfoMap(sourceFile);

    for (const fn of sourceFile.getFunctions()) {
      if (!isTopLevelDeclaration(fn, sourceFile)) continue;
      const name = fn.getName();
      if (name === undefined || !isHookName(name)) continue;

      const exportInfo = mergeExportInfo(
        exportMap.get(name),
        fn.isDefaultExport(),
        fn.hasExportKeyword(),
        name,
      );
      const body = fn.getBody();
      const hookCalls = body === undefined ? [] : this.collectHookCalls(body);
      const parameters = this.extractHookParameters(fn);
      const start = getLineAndColumn(fn);
      const end = getEndLineAndColumn(fn);

      const detection: HookDetection = {
        name,
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
        isDefaultExport: exportInfo.isDefaultExport,
        isNamedExport: exportInfo.namedExportNames.length > 0,
        hookCalls,
        parameters,
      };

      detections.push(detection);
      this.transientDiagnostics.push({
        severity: "info",
        message: `CMP002 Hook detected: "${detection.name}" (calls: ${hookCalls.join(", ")})`,
        line: start.line,
        column: start.column,
      });
    }

    for (const statement of sourceFile.getVariableStatements()) {
      if (!isTopLevelStatement(statement, sourceFile)) continue;
      const isDefaultExport = statement.hasDefaultKeyword();
      const hasNamedExport = statement.hasExportKeyword();

      for (const declaration of statement.getDeclarations()) {
        const name = declaration.getName();
        if (!isHookName(name)) continue;
        const initializer = declaration.getInitializer();
        if (
          initializer === undefined ||
          (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))
        ) {
          continue;
        }

        const exportInfo = mergeExportInfo(
          exportMap.get(name),
          isDefaultExport,
          hasNamedExport,
          name,
        );
        const body = initializer.getBody();
        const hookCalls = this.collectHookCalls(body);
        const parameters = this.extractHookParameters(initializer);
        const start = getLineAndColumn(declaration);
        const end = getEndLineAndColumn(declaration);

        const detection: HookDetection = {
          name,
          line: start.line,
          column: start.column,
          endLine: end.line,
          endColumn: end.column,
          isDefaultExport: exportInfo.isDefaultExport,
          isNamedExport: exportInfo.namedExportNames.length > 0,
          hookCalls,
          parameters,
        };

        detections.push(detection);
        this.transientDiagnostics.push({
          severity: "info",
          message: `CMP002 Hook detected: "${detection.name}" (calls: ${hookCalls.join(", ")})`,
          line: start.line,
          column: start.column,
        });
      }
    }

    return dedupeHooks(detections).sort(compareHookDetection);
  }

  private extractProps(node: Node, detection: ComponentDetection): PatternProperty[] {
    if (detection.kind === "vue-sfc" || detection.kind === "svelte-sfc") {
      return [...detection.props];
    }

    if (Node.isClassDeclaration(node)) {
      return this.extractClassComponentProps(node, detection.name);
    }

    if (Node.isVariableDeclaration(node)) {
      return this.extractVariableComponentProps(node, detection.name);
    }

    if (
      Node.isFunctionDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node)
    ) {
      return this.extractFunctionComponentProps(node, detection.name);
    }

    return [];
  }

  private extractReturnJsx(node: Node): JsxAnalysis {
    const jsxNodes: Node[] = [];
    collectReturnedJsxNodes(node, jsxNodes);

    if (jsxNodes.length === 0) {
      return emptyJsxAnalysis();
    }

    const childComponentRefs = new Set<string>();
    const providerContextNames = new Set<string>();
    let htmlElementCount = 0;
    let componentElementCount = 0;
    let hasConditionalRendering = false;
    let hasListRendering = false;
    let hasFragments = false;
    let depth = 0;

    for (const jsxNode of jsxNodes) {
      jsxNode.forEachDescendant((descendant) => {
        if (Node.isConditionalExpression(descendant)) {
          hasConditionalRendering = true;
        } else if (
          Node.isBinaryExpression(descendant) &&
          descendant.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken
        ) {
          hasConditionalRendering = true;
        } else if (Node.isJsxFragment(descendant)) {
          hasFragments = true;
        } else if (Node.isCallExpression(descendant) && isMapCallExpression(descendant)) {
          hasListRendering = true;
        }
      });

      scanJsxElements(jsxNode, (tagName, currentDepth) => {
        if (currentDepth > depth) depth = currentDepth;
        if (tagName === "Fragment" || tagName === "React.Fragment") {
          hasFragments = true;
        }

        const parsed = parseTagName(tagName);
        if (parsed.kind === "html") {
          htmlElementCount += 1;
          return;
        }

        componentElementCount += 1;
        childComponentRefs.add(parsed.reference);
        if (parsed.contextName !== null) {
          providerContextNames.add(parsed.contextName);
        }
      });
    }

    return {
      hasJsx: true,
      childComponentRefs: [...childComponentRefs].sort(compare),
      htmlElementCount,
      componentElementCount,
      hasConditionalRendering,
      hasListRendering,
      hasFragments,
      depth,
      providerContextNames: [...providerContextNames].sort(compare),
    };
  }

  private classifyComponent(detection: ComponentDetection, jsxAnalysis: JsxAnalysis): PatternType {
    if (
      isHocName(detection.name) &&
      detection.hocSignals.takesComponentParam &&
      detection.hocSignals.returnsComponent
    ) {
      return "hoc";
    }

    if (
      detection.name.endsWith("Provider") &&
      (jsxAnalysis.providerContextNames.length > 0 ||
        jsxAnalysis.childComponentRefs.some((name) => name.endsWith("Provider")))
    ) {
      return "provider";
    }

    return "component";
  }

  private detectFramework(detection: ComponentDetection, filePath: string): string {
    const extension = getExtension(filePath);
    if (extension === "vue") return "vue";
    if (extension === "svelte") return "svelte";

    const importPattern = this.currentImportIndex?.patternsByFile.get(filePath);
    const externalPackages = readStringArray(importPattern?.metadata["externalPackages"]);

    for (const pkg of externalPackages) {
      if (REACT_FRAMEWORK_PACKAGES.has(pkg)) return "react";
      if (pkg.startsWith(ANGULAR_PREFIX)) return "angular";
      if (pkg === "solid-js") return "solid";
      if (pkg === "preact") return "preact";
    }

    return detection.hasJsx ? "react" : "unknown";
  }

  private buildComponentPattern(
    detection: ComponentDetection,
    fileInfo: FileComponentInfo,
    importIndex: ImportDataIndex,
  ): PatternResult {
    const pathType = classifyByPath(fileInfo.filePath);
    const baseType = this.classifyComponent(detection, detection.jsxAnalysis);
    const type = baseType === "component" ? pathType : baseType;
    const framework = this.detectFramework(detection, fileInfo.filePath);

    const properties: Record<string, PatternProperty> = {};
    for (const prop of [...detection.props].sort(compareProperty)) {
      properties[prop.name] = prop;
    }

    const confidence = this.buildComponentConfidence(detection, type);

    const metadata: Record<string, unknown> = {
      componentKind: detection.kind,
      isDefaultExport: detection.isDefaultExport,
      isNamedExport: detection.isNamedExport,
      wrappers: detection.wrappers.map((wrapper) => ({
        wrapper: wrapper.wrapper,
        line: wrapper.line,
      })),
      jsx: {
        childComponentRefs: detection.jsxAnalysis.childComponentRefs,
        htmlElementCount: detection.jsxAnalysis.htmlElementCount,
        componentElementCount: detection.jsxAnalysis.componentElementCount,
        hasConditionalRendering: detection.jsxAnalysis.hasConditionalRendering,
        hasListRendering: detection.jsxAnalysis.hasListRendering,
        hasFragments: detection.jsxAnalysis.hasFragments,
        depth: detection.jsxAnalysis.depth,
      },
      propCount: detection.props.length,
      requiredPropCount: detection.props.filter((prop) => prop.required).length,
      hasChildren: detection.props.some((prop) => prop.name === "children") || detection.jsxAnalysis.depth > 1,
      hasRef: detection.wrappers.some((wrapper) => wrapper.wrapper === "forwardRef"),
      exportName: detection.exportName,
      _componentDependencies: this.computeComponentDependencies(
        detection,
        fileInfo,
        importIndex,
      ),
    };

    if (type === "provider") {
      metadata["contextName"] = detection.contextName ?? detection.jsxAnalysis.providerContextNames[0] ?? null;
    }
    if (type === "hoc") {
      metadata["wrapsComponent"] = detection.hocSignals.takesComponentParam;
    }

    return {
      id: `${fileInfo.filePath}:${detection.name}:${detection.line}` as PatternId,
      type,
      name: detection.name,
      filePath: fileInfo.filePath,
      location: {
        file: fileInfo.filePath,
        start: { line: detection.line, column: detection.column },
        end: { line: detection.endLine, column: detection.endColumn },
      },
      confidence,
      framework,
      dependencies: [],
      properties,
      metadata,
    };
  }

  private buildHookPattern(
    detection: HookDetection,
    fileInfo: FileComponentInfo,
    _importIndex: ImportDataIndex,
  ): PatternResult {
    const properties: Record<string, PatternProperty> = {};
    for (const parameter of detection.parameters) {
      properties[parameter.name] = {
        name: parameter.name,
        type: parameter.type,
        required: parameter.required,
        ...(parameter.defaultValue !== undefined
          ? { defaultValue: parameter.defaultValue }
          : {}),
      };
    }

    const callsHooks = detection.hookCalls.length > 0;
    const factors = [
      { name: "use-prefix", weight: 0.4, score: 1.0 },
      { name: "exported", weight: 0.3, score: detection.isDefaultExport || detection.isNamedExport ? 1.0 : 0.0 },
      { name: "calls-hooks", weight: 0.3, score: callsHooks ? 1.0 : 0.5 },
    ] as const;

    const confidenceValue = factors.reduce((sum, factor) => sum + factor.weight * factor.score, 0);

    return {
      id: `${fileInfo.filePath}:${detection.name}:${detection.line}` as PatternId,
      type: "hook",
      name: detection.name,
      filePath: fileInfo.filePath,
      location: {
        file: fileInfo.filePath,
        start: { line: detection.line, column: detection.column },
        end: { line: detection.endLine, column: detection.endColumn },
      },
      confidence: {
        value: confidenceValue,
        source: "component-analysis",
        factors: factors.map((factor) => ({ ...factor })),
      },
      framework: "react",
      dependencies: [],
      properties,
      metadata: {
        hookCalls: detection.hookCalls,
        parameterCount: detection.parameters.length,
        isDefaultExport: detection.isDefaultExport,
        isNamedExport: detection.isNamedExport,
      },
    };
  }

  private buildImportDataIndex(context: AnalyzerContext): ImportDataIndex {
    const output = context.dependencyOutputs.get("import");
    if (output === undefined) {
      this.runDiagnostics.push({
        severity: "warning",
        filePath: ".",
        message: "CMP006 ImportAnalyzer output not available; framework detection using extension only",
        line: 1,
        column: 0,
      });
      return {
        available: false,
        patternsByFile: new Map(),
      };
    }

    const byFile = new Map<string, PatternResult>();
    const sortedPatterns = [...output.patterns].sort((a, b) =>
      compare(a.filePath, b.filePath) || compare(a.id as string, b.id as string));

    for (const pattern of sortedPatterns) {
      if (byFile.has(pattern.filePath)) continue;
      byFile.set(pattern.filePath, pattern);
    }

    return {
      available: true,
      patternsByFile: byFile,
    };
  }

  private buildComponentConfidence(
    detection: ComponentDetection,
    type: PatternType,
  ): PatternResult["confidence"] {
    if (detection.kind === "vue-sfc" || detection.kind === "svelte-sfc") {
      const hasScriptBlock = detection.props.length > 0 ? 1.0 : 0.5;
      const hasProps = detection.props.length > 0 ? 1.0 : 0.0;
      const factors = [
        { name: "sfc-extension", weight: 0.5, score: 1.0 },
        { name: "has-script-block", weight: 0.3, score: hasScriptBlock },
        { name: "has-props", weight: 0.2, score: hasProps },
      ];
      const value = factors.reduce((sum, factor) => sum + factor.weight * factor.score, 0);
      return {
        value,
        source: "component-analysis",
        factors,
      };
    }

    if (type === "hoc") {
      const withPrefix = isHocName(detection.name) ? 1.0 : 0.0;
      const takesComponentParam = detection.hocSignals.takesComponentParam ? 1.0 : 0.0;
      const returnsComponent = detection.hocSignals.returnsComponent ? 0.7 : 0.0;
      const factors = [
        { name: "with-prefix", weight: 0.3, score: withPrefix },
        { name: "takes-component-param", weight: 0.4, score: takesComponentParam },
        { name: "returns-component", weight: 0.3, score: returnsComponent },
      ];
      const value = factors.reduce((sum, factor) => sum + factor.weight * factor.score, 0);
      return {
        value,
        source: "component-analysis",
        factors,
      };
    }

    const isExported = detection.isDefaultExport || detection.isNamedExport;
    const isPascal = isPascalCase(detection.name);
    const hasTypedPropsScore = detection.hasTypedProps ? 1.0 : detection.hasAnyProps ? 0.5 : 0.0;

    const factors = [
      { name: "has-jsx-return", weight: 0.4, score: detection.hasJsx ? 1.0 : 0.0 },
      { name: "exported", weight: 0.25, score: isExported ? 1.0 : 0.0 },
      { name: "pascal-case-name", weight: 0.2, score: isPascal ? 1.0 : 0.0 },
      { name: "has-typed-props", weight: 0.15, score: hasTypedPropsScore },
    ];

    const value = factors.reduce((sum, factor) => sum + factor.weight * factor.score, 0);
    return {
      value,
      source: "component-analysis",
      factors,
    };
  }

  private detectComponentKind(node: Node, wrappers: readonly WrapperInfo[]): ComponentKind | null {
    const wrapperKinds = new Set(wrappers.map((wrapper) => wrapper.wrapper));
    if (wrapperKinds.has("forwardRef")) return "forwardRef";
    if (wrapperKinds.has("memo")) return "memo";

    if (Node.isFunctionDeclaration(node)) return "function-declaration";
    if (Node.isArrowFunction(node)) return "arrow-function";
    if (Node.isFunctionExpression(node)) return "function-expression";
    if (Node.isClassDeclaration(node) && isReactClassComponent(node)) return "class-component";
    if (Node.isClassExpression(node)) return "class-component";

    return null;
  }

  private computeHocSignals(node: Node, name: string): HocSignals {
    if (!isHocName(name)) {
      return { takesComponentParam: false, returnsComponent: false };
    }

    const fn = toFunctionLike(node);
    if (fn === null) {
      return { takesComponentParam: false, returnsComponent: false };
    }

    const firstParameter = fn.getParameters()[0];
    const takesComponentParam = firstParameter !== undefined && isComponentParameterName(firstParameter.getName());
    const returnsComponent = functionReturnsComponentFactory(fn);

    return { takesComponentParam, returnsComponent };
  }

  private pushComponentDiagnostics(detection: ComponentDetection): void {
    this.transientDiagnostics.push({
      severity: "info",
      message: `CMP001 Component detected: "${detection.name}" (${detection.kind})`,
      line: detection.line,
      column: detection.column,
    });

    const exported = detection.isDefaultExport || detection.isNamedExport;
    if (!exported) {
      this.transientDiagnostics.push({
        severity: "info",
        message: `CMP007 Non-exported component: "${detection.name}" - internal to module`,
        line: detection.line,
        column: detection.column,
      });
    }
  }

  private extractHookParameters(fn: ComponentFunctionLike): HookParameter[] {
    const params: HookParameter[] = [];

    for (const param of fn.getParameters()) {
      const name = normalizeParameterName(param.getName());
      const type = param.getTypeNode()?.getText() ?? "unknown";
      const required = !param.isOptional() && !param.hasInitializer();
      const initializer = param.getInitializer();

      params.push({
        name,
        type,
        required,
        ...(initializer !== undefined ? { defaultValue: initializer.getText() } : {}),
      });
    }

    return params.sort((a, b) => compare(a.name, b.name));
  }

  private collectHookCalls(node: Node): string[] {
    const calls = new Set<string>();

    node.forEachDescendant((descendant) => {
      if (!Node.isCallExpression(descendant)) return;

      const expression = descendant.getExpression();
      if (Node.isIdentifier(expression)) {
        const name = expression.getText();
        if (isHookName(name) || HOOK_CALL_ALLOWLIST.has(name)) {
          calls.add(name);
        }
        return;
      }

      if (Node.isPropertyAccessExpression(expression)) {
        const name = expression.getName();
        if (isHookName(name) || HOOK_CALL_ALLOWLIST.has(name)) {
          calls.add(name);
        }
      }
    });

    return [...calls].sort(compare);
  }

  private extractClassComponentProps(classDeclaration: ClassDeclaration, name: string): PatternProperty[] {
    const props: PatternProperty[] = [];
    const heritage = classDeclaration.getHeritageClauses();

    for (const clause of heritage) {
      if (clause.getToken() !== SyntaxKind.ExtendsKeyword) continue;

      for (const typeNode of clause.getTypeNodes()) {
        if (!Node.isExpressionWithTypeArguments(typeNode)) continue;
        const text = typeNode.getExpression().getText();
        if (!isReactComponentBase(text)) continue;

        const typeArgs = typeNode.getTypeArguments();
        const propsType = typeArgs[0];
        if (propsType === undefined) continue;

        const extracted = this.extractPropertiesFromTypeNode(
          propsType,
          classDeclaration.getSourceFile(),
          name,
          new Map(),
        );
        props.push(...extracted);
      }
    }

    return dedupeProperties(props);
  }

  private extractVariableComponentProps(declaration: VariableDeclaration, name: string): PatternProperty[] {
    const initializer = declaration.getInitializer();
    if (initializer === undefined) return [];

    const unwrap = unwrapWrappers(initializer);
    const coreNode = unwrap.node;

    if (!Node.isArrowFunction(coreNode) && !Node.isFunctionExpression(coreNode)) {
      return this.extractPropsFromVariableTypeAnnotation(declaration, name);
    }

    const fromFunction = this.extractFunctionComponentProps(coreNode, name);
    if (fromFunction.length > 0) {
      return fromFunction;
    }

    return this.extractPropsFromVariableTypeAnnotation(declaration, name);
  }

  private extractFunctionComponentProps(functionLike: ComponentFunctionLike, name: string): PatternProperty[] {
    const propsParam = functionLike.getParameters()[0];
    if (propsParam === undefined) {
      return [];
    }

    const defaults = collectObjectBindingDefaults(propsParam.getNameNode());

    const typeNode = propsParam.getTypeNode();
    if (typeNode !== undefined) {
      const fromType = this.extractPropertiesFromTypeNode(
        typeNode,
        functionLike.getSourceFile(),
        name,
        defaults,
      );
      if (fromType.length > 0) {
        return dedupeProperties(fromType);
      }
    }

    const nameNode = propsParam.getNameNode();
    if (Node.isObjectBindingPattern(nameNode)) {
      const fromDestructure = this.extractFromObjectBindingPattern(
        nameNode,
        typeNode,
        functionLike.getSourceFile(),
        name,
      );
      if (fromDestructure.length > 0) {
        return dedupeProperties(fromDestructure);
      }
    }

    return [];
  }

  private extractPropsFromVariableTypeAnnotation(
    declaration: VariableDeclaration,
    componentName: string,
  ): PatternProperty[] {
    const typeNode = declaration.getTypeNode();
    if (typeNode === undefined) {
      return [];
    }

    if (!Node.isTypeReference(typeNode)) {
      return [];
    }

    const typeName = typeNode.getTypeName().getText();
    if (typeName !== "FC" && typeName !== "React.FC") {
      return [];
    }

    const arg = typeNode.getTypeArguments()[0];
    if (arg === undefined) {
      return [];
    }

    return this.extractPropertiesFromTypeNode(
      arg,
      declaration.getSourceFile(),
      componentName,
      new Map(),
    );
  }

  private extractPropertiesFromTypeNode(
    typeNode: TypeNode,
    sourceFile: SourceFile,
    componentName: string,
    defaultValueMap: ReadonlyMap<string, string>,
  ): PatternProperty[] {
    const properties = this.resolveTypeProperties(typeNode, sourceFile);
    if (properties.length === 0) {
      this.transientDiagnostics.push({
        severity: "info",
        message: `CMP005 Props extraction incomplete for "${componentName}": unsupported or unresolved type` ,
        line: getLineAndColumn(typeNode).line,
        column: getLineAndColumn(typeNode).column,
      });
      return [];
    }

    const results: PatternProperty[] = [];
    for (const property of properties) {
      results.push({
        name: property.name,
        type: property.type,
        required: property.required,
        ...(defaultValueMap.has(property.name)
          ? { defaultValue: defaultValueMap.get(property.name) }
          : {}),
      });
    }

    return results.sort(compareProperty);
  }

  private resolveTypeProperties(typeNode: TypeNode, sourceFile: SourceFile): TypePropertyInfo[] {
    if (Node.isTypeLiteral(typeNode)) {
      return this.resolveTypeLiteralProperties(typeNode);
    }

    if (Node.isParenthesizedTypeNode(typeNode)) {
      return this.resolveTypeProperties(typeNode.getTypeNode(), sourceFile);
    }

    if (Node.isIntersectionTypeNode(typeNode) || Node.isUnionTypeNode(typeNode)) {
      const merged = new Map<string, TypePropertyInfo>();
      for (const inner of typeNode.getTypeNodes()) {
        for (const prop of this.resolveTypeProperties(inner, sourceFile)) {
          if (!merged.has(prop.name)) {
            merged.set(prop.name, prop);
          }
        }
      }
      return [...merged.values()].sort((a, b) => compare(a.name, b.name));
    }

    if (!Node.isTypeReference(typeNode)) {
      return [];
    }

    const refName = typeNode.getTypeName().getText();
    const simpleName = refName.includes(".")
      ? refName.split(".")[refName.split(".").length - 1]!
      : refName;

    const iface = sourceFile.getInterfaces().find((item) => item.getName() === simpleName);
    if (iface !== undefined) {
      const props: TypePropertyInfo[] = [];
      for (const member of iface.getMembers()) {
        if (!Node.isPropertySignature(member)) continue;
        const memberName = member.getName();
        if (memberName.length === 0) continue;
        props.push({
          name: memberName,
          type: member.getTypeNode()?.getText() ?? "unknown",
          required: !member.hasQuestionToken(),
        });
      }
      return props.sort((a, b) => compare(a.name, b.name));
    }

    const alias = sourceFile.getTypeAlias(simpleName);
    if (alias !== undefined) {
      const aliasTypeNode = alias.getTypeNode();
      if (aliasTypeNode !== undefined) {
        return this.resolveTypeProperties(aliasTypeNode, sourceFile);
      }
    }

    return [];
  }

  private resolveTypeLiteralProperties(typeLiteral: TypeNode & { getMembers(): readonly Node[] }): TypePropertyInfo[] {
    const properties: TypePropertyInfo[] = [];
    for (const member of typeLiteral.getMembers()) {
      if (!Node.isPropertySignature(member)) continue;
      const name = member.getName();
      if (name.length === 0) continue;
      properties.push({
        name,
        type: member.getTypeNode()?.getText() ?? "unknown",
        required: !member.hasQuestionToken(),
      });
    }
    return properties.sort((a, b) => compare(a.name, b.name));
  }

  private extractFromObjectBindingPattern(
    pattern: ObjectBindingPattern,
    typeNode: TypeNode | undefined,
    sourceFile: SourceFile,
    componentName: string,
  ): PatternProperty[] {
    const resolvedFromType = typeNode === undefined
      ? []
      : this.resolveTypeProperties(typeNode, sourceFile);

    const byName = new Map<string, TypePropertyInfo>();
    for (const item of resolvedFromType) {
      byName.set(item.name, item);
    }

    const properties: PatternProperty[] = [];
    for (const element of pattern.getElements()) {
      const nameNode = element.getNameNode();
      if (!Node.isIdentifier(nameNode)) continue;

      const localName = nameNode.getText();
      const propertyNameNode = element.getPropertyNameNode();
      const propName = propertyNameNode === undefined ? localName : propertyNameNode.getText();
      const fromType = byName.get(propName);
      const initializer = element.getInitializer();

      properties.push({
        name: propName,
        type: fromType?.type ?? "unknown",
        required: initializer === undefined && (fromType?.required ?? true),
        ...(initializer !== undefined ? { defaultValue: initializer.getText() } : {}),
      });
    }

    if (properties.length === 0 && typeNode !== undefined) {
      this.transientDiagnostics.push({
        severity: "info",
        message: `CMP005 Props extraction incomplete for "${componentName}": destructuring pattern not fully resolvable`,
        line: getLineAndColumn(pattern).line,
        column: getLineAndColumn(pattern).column,
      });
    }

    return properties.sort(compareProperty);
  }

  private extractVueDefineProps(sourceFile: SourceFile, componentName: string): PatternProperty[] {
    const results: PatternProperty[] = [];

    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      if (node.getExpression().getText() !== "defineProps") return;

      const typeArg = node.getTypeArguments()[0];
      if (typeArg !== undefined) {
        results.push(...this.extractPropertiesFromTypeNode(typeArg, sourceFile, componentName, new Map()));
        return;
      }

      const firstArg = node.getArguments()[0];
      if (firstArg === undefined || !Node.isObjectLiteralExpression(firstArg)) return;
      for (const property of firstArg.getProperties()) {
        if (!Node.isPropertyAssignment(property)) continue;
        const propName = property.getName();
        const init = property.getInitializer();
        if (!Node.isObjectLiteralExpression(init)) {
          results.push({
            name: propName,
            type: "unknown",
            required: false,
          });
          continue;
        }

        let required = false;
        let type = "unknown";
        let defaultValue: string | undefined;

        for (const option of init.getProperties()) {
          if (!Node.isPropertyAssignment(option)) continue;
          const optionName = option.getName();
          const optionValue = option.getInitializer();
          if (optionValue === undefined) continue;

          if (optionName === "required" && optionValue.getText() === "true") {
            required = true;
          } else if (optionName === "type") {
            type = optionValue.getText();
          } else if (optionName === "default") {
            defaultValue = optionValue.getText();
          }
        }

        results.push({
          name: propName,
          type,
          required,
          ...(defaultValue !== undefined ? { defaultValue } : {}),
        });
      }
    });

    return dedupeProperties(results);
  }

  private extractVueOptionsApiProps(sourceFile: SourceFile, _componentName: string): PatternProperty[] {
    const results: PatternProperty[] = [];

    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      if (node.getExpression().getText() !== "defineComponent") return;
      const firstArg = node.getArguments()[0];
      if (!Node.isObjectLiteralExpression(firstArg)) return;

      const propsProperty = firstArg.getProperty("props");
      if (propsProperty === undefined || !Node.isPropertyAssignment(propsProperty)) return;
      const initializer = propsProperty.getInitializer();
      if (!Node.isObjectLiteralExpression(initializer)) return;

      for (const propEntry of initializer.getProperties()) {
        if (!Node.isPropertyAssignment(propEntry)) continue;
        const propName = propEntry.getName();
        const init = propEntry.getInitializer();

        if (!Node.isObjectLiteralExpression(init)) {
          results.push({
            name: propName,
            type: "unknown",
            required: false,
          });
          continue;
        }

        let required = false;
        let type = "unknown";
        let defaultValue: string | undefined;

        for (const item of init.getProperties()) {
          if (!Node.isPropertyAssignment(item)) continue;
          const itemName = item.getName();
          const itemValue = item.getInitializer();
          if (itemValue === undefined) continue;

          if (itemName === "required" && itemValue.getText() === "true") {
            required = true;
          } else if (itemName === "type") {
            type = itemValue.getText();
          } else if (itemName === "default") {
            defaultValue = itemValue.getText();
          }
        }

        results.push({
          name: propName,
          type,
          required,
          ...(defaultValue !== undefined ? { defaultValue } : {}),
        });
      }
    });

    return dedupeProperties(results);
  }

  private extractSvelteProps(sourceFile: SourceFile): PatternProperty[] {
    const results: PatternProperty[] = [];

    for (const statement of sourceFile.getVariableStatements()) {
      const declarationKind = statement.getDeclarationKind();
      if (declarationKind !== "let") continue;

      const isExport = statement.hasExportKeyword();

      for (const declaration of statement.getDeclarations()) {
        const nameNode = declaration.getNameNode();
        const initializer = declaration.getInitializer();

        if (isExport && Node.isIdentifier(nameNode)) {
          results.push({
            name: nameNode.getText(),
            type: declaration.getTypeNode()?.getText() ?? "unknown",
            required: initializer === undefined,
            ...(initializer !== undefined ? { defaultValue: initializer.getText() } : {}),
          });
          continue;
        }

        if (
          Node.isObjectBindingPattern(nameNode) &&
          initializer !== undefined &&
          Node.isCallExpression(initializer) &&
          initializer.getExpression().getText() === "$props"
        ) {
          for (const element of nameNode.getElements()) {
            const local = element.getNameNode();
            if (!Node.isIdentifier(local)) continue;
            const propertyNameNode = element.getPropertyNameNode();
            const propName = propertyNameNode === undefined
              ? local.getText()
              : propertyNameNode.getText();
            const elementInit = element.getInitializer();
            results.push({
              name: propName,
              type: "unknown",
              required: elementInit === undefined,
              ...(elementInit !== undefined ? { defaultValue: elementInit.getText() } : {}),
            });
          }
        }
      }
    }

    return dedupeProperties(results);
  }

  private computeComponentDependencies(
    detection: ComponentDetection,
    fileInfo: FileComponentInfo,
    importIndex: ImportDataIndex,
  ): PatternId[] {
    if (!importIndex.available) return [];

    const importPattern = importIndex.patternsByFile.get(fileInfo.filePath);
    if (importPattern === undefined) return [];

    const bindings = this.extractImportBindings(importPattern);
    if (bindings.length === 0) return [];

    const deps = new Set<PatternId>();

    for (const childRef of detection.jsxAnalysis.childComponentRefs) {
      const binding = bindings.find((item) => item.localName === childRef);
      if (binding === undefined) continue;

      const targetFile = binding.resolvedPath;
      const targetInfo = this.currentTargetPatternIndex.byFile.get(targetFile);
      if (targetInfo === undefined) continue;

      const target = resolveTargetPattern(targetInfo, binding);
      if (target === null) continue;

      deps.add(target.id);
    }

    return [...deps].sort((a, b) => compare(a as string, b as string));
  }

  private extractImportBindings(importPattern: PatternResult): ImportBinding[] {
    const importsValue = importPattern.metadata["imports"];
    if (!Array.isArray(importsValue)) return [];

    const bindings: ImportBinding[] = [];

    for (const importEntry of importsValue) {
      if (!isRecord(importEntry)) continue;
      const resolvedPathRaw = importEntry["resolvedPath"];
      if (typeof resolvedPathRaw !== "string") continue;
      const resolvedPath = normalizeToPosix(resolvedPathRaw);

      const symbols = importEntry["symbols"];
      if (!Array.isArray(symbols)) continue;

      for (const symbolEntry of symbols) {
        if (!isRecord(symbolEntry)) continue;
        const kindValue = symbolEntry["kind"];
        const nameValue = symbolEntry["name"];
        const aliasValue = symbolEntry["alias"];
        if (
          (kindValue !== "default" && kindValue !== "named" && kindValue !== "namespace" && kindValue !== "side-effect") ||
          typeof nameValue !== "string"
        ) {
          continue;
        }

        const localName = typeof aliasValue === "string"
          ? aliasValue
          : kindValue === "default"
          ? "default"
          : nameValue;

        bindings.push({
          localName,
          importedName: nameValue,
          kind: kindValue,
          resolvedPath,
        });
      }
    }

    return bindings.sort((a, b) =>
      compare(a.localName, b.localName) ||
      compare(a.resolvedPath, b.resolvedPath) ||
      compare(a.importedName, b.importedName));
  }

  private patchComponentDependencies(pattern: PatternResult): {
    readonly dependencies: readonly PatternId[];
    readonly metadata: Readonly<Record<string, unknown>>;
  } {
    const raw = pattern.metadata["_componentDependencies"];
    const deps = Array.isArray(raw)
      ? raw.filter((value): value is PatternId => typeof value === "string")
      : [];

    const sorted = [...new Set(deps)].sort((a, b) => compare(a as string, b as string));

    const metadata = { ...pattern.metadata };
    delete metadata["_componentDependencies"];

    return {
      dependencies: sorted,
      metadata,
    };
  }

  private buildTargetPatternIndex(patterns: readonly PatternResult[]): TargetPatternIndex {
    const grouped = new Map<string, PatternResult[]>();

    for (const pattern of patterns) {
      if (pattern.type === "hook") continue;
      const list = grouped.get(pattern.filePath);
      if (list === undefined) {
        grouped.set(pattern.filePath, [pattern]);
      } else {
        list.push(pattern);
      }
    }

    const byFile = new Map<string, {
      all: readonly PatternResult[];
      byName: ReadonlyMap<string, PatternResult>;
      byExportName: ReadonlyMap<string, PatternResult>;
      defaultPattern: PatternResult | null;
    }>();

    for (const [filePath, list] of [...grouped.entries()].sort((a, b) => compare(a[0], b[0]))) {
      const sortedList = [...list].sort((a, b) => compare(a.id as string, b.id as string));
      const byName = new Map<string, PatternResult>();
      const byExportName = new Map<string, PatternResult>();
      let defaultPattern: PatternResult | null = null;

      for (const pattern of sortedList) {
        if (!byName.has(pattern.name)) {
          byName.set(pattern.name, pattern);
        }

        const exportName = typeof pattern.metadata["exportName"] === "string"
          ? pattern.metadata["exportName"]
          : undefined;
        if (exportName !== undefined && !byExportName.has(exportName)) {
          byExportName.set(exportName, pattern);
        }

        if (pattern.metadata["isDefaultExport"] === true && defaultPattern === null) {
          defaultPattern = pattern;
        }
      }

      byFile.set(filePath, {
        all: sortedList,
        byName,
        byExportName,
        defaultPattern,
      });
    }

    return { byFile };
  }

  private buildTargetPatternIndexFromFileInfos(
    fileInfos: readonly FileComponentInfo[],
  ): TargetPatternIndex {
    const syntheticPatterns: PatternResult[] = [];

    for (const fileInfo of fileInfos) {
      for (const component of fileInfo.components) {
        syntheticPatterns.push({
          id: `${fileInfo.filePath}:${component.name}:${component.line}` as PatternId,
          type: "component",
          name: component.name,
          filePath: fileInfo.filePath,
          location: {
            file: fileInfo.filePath,
            start: { line: component.line, column: component.column },
            end: { line: component.endLine, column: component.endColumn },
          },
          confidence: {
            value: 1,
            source: "component-analysis",
            factors: [{ name: "synthetic", weight: 1, score: 1 }],
          },
          framework: "unknown",
          dependencies: [],
          properties: {},
          metadata: {
            exportName: component.exportName,
            isDefaultExport: component.isDefaultExport,
          },
        });
      }
    }

    return this.buildTargetPatternIndex(syntheticPatterns);
  }
}

function resolveTargetPattern(
  targetInfo: {
    readonly all: readonly PatternResult[];
    readonly byName: ReadonlyMap<string, PatternResult>;
    readonly byExportName: ReadonlyMap<string, PatternResult>;
    readonly defaultPattern: PatternResult | null;
  },
  binding: ImportBinding,
): PatternResult | null {
  if (binding.kind === "default") {
    if (targetInfo.defaultPattern !== null) return targetInfo.defaultPattern;
    return targetInfo.all[0] ?? null;
  }

  if (binding.kind === "named") {
    const byExport = targetInfo.byExportName.get(binding.importedName);
    if (byExport !== undefined) return byExport;
    const byName = targetInfo.byName.get(binding.importedName);
    if (byName !== undefined) return byName;
  }

  if (binding.kind === "namespace") {
    return null;
  }

  return targetInfo.all[0] ?? null;
}

function emptyJsxAnalysis(): JsxAnalysis {
  return {
    hasJsx: false,
    childComponentRefs: [],
    htmlElementCount: 0,
    componentElementCount: 0,
    hasConditionalRendering: false,
    hasListRendering: false,
    hasFragments: false,
    depth: 0,
    providerContextNames: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").sort(compare);
}

function isTopLevelDeclaration(node: Node, sourceFile: SourceFile): boolean {
  return node.getParent() === sourceFile;
}

function isTopLevelStatement(node: Node, sourceFile: SourceFile): boolean {
  return node.getParent() === sourceFile;
}

function isComponentLikeName(name: string): boolean {
  return isPascalCase(name) || isHocName(name) || name.endsWith("Provider");
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

function isHocName(name: string): boolean {
  return /^with[A-Z]/.test(name);
}

function isComponentParameterName(name: string): boolean {
  return /^[A-Z]/.test(name) || name === "Component" || name === "WrappedComponent";
}

function isReactClassComponent(classDeclaration: ClassDeclaration): boolean {
  const extendsClause = classDeclaration.getExtends();
  if (extendsClause === undefined) return false;
  const extendsText = extendsClause.getExpression().getText();
  if (!isReactComponentBase(extendsText)) return false;
  return classDeclaration.getMethod("render") !== undefined;
}

function isReactComponentBase(name: string): boolean {
  return name === "Component" ||
    name === "PureComponent" ||
    name === "React.Component" ||
    name === "React.PureComponent";
}

function unwrapWrappers(node: Node): WrapperUnwrapResult {
  const wrappers: WrapperInfo[] = [];
  let current: Node = node;

  while (Node.isCallExpression(current)) {
    const wrapper = detectWrapperKind(current);
    if (wrapper === null) break;

    wrappers.push({
      wrapper,
      line: getLineAndColumn(current).line,
    });

    const firstArg = current.getArguments()[0];
    if (firstArg === undefined) break;
    current = firstArg;
  }

  return {
    node: current,
    wrappers: wrappers.sort(compareWrapperInfo),
  };
}

function detectWrapperKind(callExpression: CallExpression): WrapperKind | null {
  const expression = callExpression.getExpression();

  if (Node.isIdentifier(expression)) {
    const name = expression.getText();
    return KNOWN_WRAPPERS.has(name as WrapperKind) ? name as WrapperKind : null;
  }

  if (Node.isPropertyAccessExpression(expression)) {
    const name = expression.getName();
    return KNOWN_WRAPPERS.has(name as WrapperKind) ? name as WrapperKind : null;
  }

  return null;
}

function collectReturnedJsxNodes(node: Node, target: Node[]): void {
  if (Node.isArrowFunction(node)) {
    const body = node.getBody();
    if (isJsxNode(body)) {
      target.push(body);
      return;
    }

    if (Node.isBlock(body)) {
      for (const statement of body.getStatements()) {
        if (!Node.isReturnStatement(statement)) continue;
        const expression = statement.getExpression();
        if (expression !== undefined && isJsxNode(expression)) {
          target.push(expression);
        }
      }
    }
    return;
  }

  const fn = toFunctionLike(node);
  if (fn !== null) {
    const body = fn.getBody();
    if (body === undefined || !Node.isBlock(body)) return;
    for (const statement of body.getStatements()) {
      if (!Node.isReturnStatement(statement)) continue;
      const expression = statement.getExpression();
      if (expression !== undefined && isJsxNode(expression)) {
        target.push(expression);
      }
    }
    return;
  }

  if (Node.isMethodDeclaration(node)) {
    const body = node.getBody();
    if (body === undefined || !Node.isBlock(body)) return;
    for (const statement of body.getStatements()) {
      if (!Node.isReturnStatement(statement)) continue;
      const expression = statement.getExpression();
      if (expression !== undefined && isJsxNode(expression)) {
        target.push(expression);
      }
    }
  }
}

function toFunctionLike(node: Node): ComponentFunctionLike | null {
  if (Node.isFunctionDeclaration(node)) return node;
  if (Node.isArrowFunction(node)) return node;
  if (Node.isFunctionExpression(node)) return node;
  return null;
}

function isJsxNode(node: Node): boolean {
  return Node.isJsxElement(node) ||
    Node.isJsxSelfClosingElement(node) ||
    Node.isJsxFragment(node);
}

function scanJsxElements(node: Node, onTag: (tagName: string, depth: number) => void): void {
  const walk = (current: Node, depth: number): void => {
    if (Node.isJsxElement(current)) {
      onTag(current.getOpeningElement().getTagNameNode().getText(), depth);
      for (const child of current.getChildrenOfKind(SyntaxKind.JsxText)) {
        void child;
      }
      for (const child of current.getJsxChildren()) {
        walk(child, depth + 1);
      }
      return;
    }

    if (Node.isJsxSelfClosingElement(current)) {
      onTag(current.getTagNameNode().getText(), depth);
      return;
    }

    if (Node.isJsxFragment(current)) {
      onTag("Fragment", depth);
      for (const child of current.getJsxChildren()) {
        walk(child, depth + 1);
      }
      return;
    }

    if (Node.isJsxExpression(current)) {
      const expr = current.getExpression();
      if (expr !== undefined) {
        if (isJsxNode(expr)) {
          walk(expr, depth + 1);
        } else {
          expr.forEachDescendant((descendant) => {
            if (isJsxNode(descendant)) {
              walk(descendant, depth + 1);
            }
          });
        }
      }
    }
  };

  walk(node, 1);
}

function parseTagName(tagName: string): {
  readonly kind: "component" | "html";
  readonly reference: string;
  readonly contextName: string | null;
} {
  if (tagName.includes(".")) {
    const parts = tagName.split(".");
    const root = parts[0] ?? tagName;
    const tail = parts[parts.length - 1] ?? "";
    const contextName = (tail === "Provider" || tail === "Consumer") ? root : null;
    return {
      kind: /^[A-Z]/.test(root) ? "component" : "html",
      reference: root,
      contextName,
    };
  }

  if (/^[A-Z]/.test(tagName)) {
    return {
      kind: "component",
      reference: tagName,
      contextName: null,
    };
  }

  return {
    kind: "html",
    reference: tagName,
    contextName: null,
  };
}

function isMapCallExpression(node: CallExpression): boolean {
  const expression = node.getExpression();
  return Node.isPropertyAccessExpression(expression) && expression.getName() === "map";
}

function functionReturnsComponentFactory(fn: ComponentFunctionLike): boolean {
  const body = fn.getBody();
  if (Node.isExpression(body)) {
    if (isJsxNode(body)) return true;
    if (Node.isArrowFunction(body) || Node.isFunctionExpression(body)) {
      return functionReturnsComponentFactory(body);
    }
  }

  if (!Node.isBlock(body)) {
    return false;
  }

  for (const statement of body.getStatements()) {
    if (!Node.isReturnStatement(statement)) continue;
    const expression = statement.getExpression();
    if (expression === undefined) continue;

    if (isJsxNode(expression)) return true;

    if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
      if (functionReturnsComponentFactory(expression)) {
        return true;
      }
    }
  }

  return false;
}

function collectObjectBindingDefaults(node: Node): Map<string, string> {
  const defaults = new Map<string, string>();
  if (!Node.isObjectBindingPattern(node)) {
    return defaults;
  }

  for (const element of node.getElements()) {
    const nameNode = element.getNameNode();
    if (!Node.isIdentifier(nameNode)) continue;
    const propNameNode = element.getPropertyNameNode();
    const propName = propNameNode === undefined ? nameNode.getText() : propNameNode.getText();
    const initializer = element.getInitializer();
    if (initializer !== undefined) {
      defaults.set(propName, initializer.getText());
    }
  }

  return defaults;
}

function normalizeParameterName(name: string): string {
  if (name.startsWith("{")) {
    return "props";
  }
  if (name.startsWith("[")) {
    return "args";
  }
  return name;
}

function dedupeProperties(properties: readonly PatternProperty[]): PatternProperty[] {
  const byName = new Map<string, PatternProperty>();
  for (const property of properties) {
    if (!byName.has(property.name)) {
      byName.set(property.name, property);
    }
  }
  return [...byName.values()].sort(compareProperty);
}

function dedupeComponents(detections: readonly ComponentDetection[]): ComponentDetection[] {
  const map = new Map<string, ComponentDetection>();
  for (const detection of detections) {
    const key = `${detection.name}:${detection.line}:${detection.column}`;
    if (!map.has(key)) {
      map.set(key, detection);
    }
  }
  return [...map.values()].sort(compareComponentDetection);
}

function dedupeHooks(detections: readonly HookDetection[]): HookDetection[] {
  const map = new Map<string, HookDetection>();
  for (const detection of detections) {
    const key = `${detection.name}:${detection.line}:${detection.column}`;
    if (!map.has(key)) {
      map.set(key, detection);
    }
  }
  return [...map.values()].sort(compareHookDetection);
}

function compareComponentDetection(a: ComponentDetection, b: ComponentDetection): number {
  return a.line - b.line ||
    a.column - b.column ||
    compare(a.name, b.name) ||
    compare(a.kind, b.kind);
}

function compareHookDetection(a: HookDetection, b: HookDetection): number {
  return a.line - b.line ||
    a.column - b.column ||
    compare(a.name, b.name);
}

function compareProperty(a: PatternProperty, b: PatternProperty): number {
  return compare(a.name, b.name) || compare(a.type, b.type);
}

function compareFileDiagnostic(a: FileDiagnostic, b: FileDiagnostic): number {
  return a.line - b.line ||
    a.column - b.column ||
    compare(a.severity, b.severity) ||
    compare(a.message, b.message);
}

function compareWrapperInfo(a: WrapperInfo, b: WrapperInfo): number {
  return a.line - b.line || compare(a.wrapper, b.wrapper);
}

function fileBaseName(filePath: string): string {
  const normalized = normalizeToPosix(filePath);
  const name = normalized.split("/").pop() ?? normalized;
  const dotIndex = name.lastIndexOf(".");
  return dotIndex === -1 ? name : name.slice(0, dotIndex);
}

function getExtension(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dotIndex = base.lastIndexOf(".");
  return dotIndex === -1 ? "" : base.slice(dotIndex + 1).toLowerCase();
}

function toPascalCase(value: string): string {
  const parts = value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((item) => item.length > 0);

  if (parts.length === 0) return "Component";

  return parts
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
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

function buildExportInfoMap(sourceFile: SourceFile): ReadonlyMap<string, ExportInfo> {
  const map = new Map<string, { named: Set<string>; default: boolean }>();

  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (name === undefined) continue;
    const current = ensureMutableExportInfo(map, name);
    if (fn.hasExportKeyword()) {
      current.named.add(name);
    }
    if (fn.isDefaultExport()) {
      current.default = true;
    }
  }

  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (name === undefined) continue;
    const current = ensureMutableExportInfo(map, name);
    if (cls.hasExportKeyword()) {
      current.named.add(name);
    }
    if (cls.hasDefaultKeyword()) {
      current.default = true;
    }
  }

  for (const statement of sourceFile.getVariableStatements()) {
    const exported = statement.hasExportKeyword();
    const asDefault = statement.hasDefaultKeyword();

    for (const declaration of statement.getDeclarations()) {
      const current = ensureMutableExportInfo(map, declaration.getName());
      if (exported) {
        current.named.add(declaration.getName());
      }
      if (asDefault) {
        current.default = true;
      }
    }
  }

  for (const exportDeclaration of sourceFile.getExportDeclarations()) {
    if (exportDeclaration.getModuleSpecifierValue() !== undefined) continue;

    for (const named of exportDeclaration.getNamedExports()) {
      const localName = named.getNameNode().getText();
      const exportName = named.getAliasNode()?.getText() ?? localName;
      const current = ensureMutableExportInfo(map, localName);

      if (exportName === "default") {
        current.default = true;
      } else {
        current.named.add(exportName);
      }
    }
  }

  for (const assignment of sourceFile.getExportAssignments()) {
    if (assignment.isExportEquals()) continue;
    const expression = assignment.getExpression();
    if (Node.isIdentifier(expression)) {
      const current = ensureMutableExportInfo(map, expression.getText());
      current.default = true;
    }
  }

  const result = new Map<string, ExportInfo>();
  for (const [name, info] of map) {
    result.set(name, {
      namedExportNames: [...info.named].sort(compare),
      isDefaultExport: info.default,
    });
  }
  return result;
}

function ensureMutableExportInfo(
  map: Map<string, { named: Set<string>; default: boolean }>,
  name: string,
): { named: Set<string>; default: boolean } {
  const existing = map.get(name);
  if (existing !== undefined) {
    return existing;
  }

  const created = { named: new Set<string>(), default: false };
  map.set(name, created);
  return created;
}

function mergeExportInfo(
  fromMap: ExportInfo | undefined,
  defaultFromNode: boolean,
  namedFromNode: boolean,
  localName: string,
): ExportInfo {
  const named = new Set<string>(fromMap?.namedExportNames ?? []);
  if (namedFromNode && named.size === 0) {
    named.add(localName);
  }

  return {
    namedExportNames: [...named].sort(compare),
    isDefaultExport: (fromMap?.isDefaultExport ?? false) || defaultFromNode,
  };
}

function getLineAndColumn(node: Node): { line: number; column: number } {
  const start = node.getStart(false);
  return toLineAndColumn(node.getSourceFile(), start);
}

function getEndLineAndColumn(node: Node): { line: number; column: number } {
  const end = node.getEnd();
  return toLineAndColumn(node.getSourceFile(), end);
}

function toLineAndColumn(sourceFile: SourceFile, pos: number): { line: number; column: number } {
  const lineAndColumn = sourceFile.getLineAndColumnAtPos(pos);
  return {
    line: lineAndColumn.line,
    column: Math.max(0, lineAndColumn.column - 1),
  };
}

function classifyByPath(filePath: string): PatternType {
  const normalized = `/${normalizeToPosix(filePath)}`.toLowerCase();
  if (normalized.includes("/pages/") || normalized.includes("/routes/") || normalized.includes("/views/") || normalized.includes("/screens/")) {
    return "page";
  }
  if (normalized.includes("/layouts/") || normalized.includes("/layout/")) {
    return "layout";
  }
  return "component";
}

function extractVueScriptBlock(source: string): { readonly content: string } | null {
  const setup = source.match(/<script\b[^>]*\bsetup\b[^>]*>([\s\S]*?)<\/script>/i);
  if (setup !== null) {
    return { content: setup[1] ?? "" };
  }

  const normal = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
  if (normal !== null) {
    return { content: normal[1] ?? "" };
  }

  return null;
}

function extractSvelteScriptBlock(source: string): { readonly content: string } | null {
  const match = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
  if (match === null) {
    return null;
  }
  return { content: match[1] ?? "" };
}

function flattenDiagnosticMessage(message: string | ts.DiagnosticMessageChain): string {
  if (typeof message === "string") {
    return message;
  }

  const parts: string[] = [message.messageText];
  if (message.next !== undefined) {
    for (const next of message.next) {
      parts.push(flattenDiagnosticMessage(next));
    }
  }
  return parts.join(" | ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
