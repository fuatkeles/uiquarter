
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { compare, stableStringify } from "../core/utils.js";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerDiagnostic,
  AnalyzerId,
  AnalyzerOutput,
  DiscoveredFile,
  PatternId,
  PatternResult,
} from "../types/index.js";

const STYLING_EXTENSIONS = new Set([
  "css",
  "scss",
  "sass",
  "less",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
]);

const STYLE_FILE_EXTENSIONS = new Set(["css", "scss", "sass", "less"]);
const SOURCE_STYLE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "vue", "svelte"]);
const CSS_MODULE_SUFFIXES = [".module.css", ".module.scss", ".module.sass", ".module.less"] as const;

const TAILWIND_PREFIXES = [
  "flex",
  "grid",
  "block",
  "inline",
  "hidden",
  "w-",
  "h-",
  "p-",
  "m-",
  "px-",
  "py-",
  "pt-",
  "pb-",
  "pl-",
  "pr-",
  "mx-",
  "my-",
  "mt-",
  "mb-",
  "ml-",
  "mr-",
  "bg-",
  "text-",
  "font-",
  "border-",
  "rounded",
  "shadow",
  "ring",
  "opacity-",
  "z-",
  "gap-",
  "space-",
  "items-",
  "justify-",
  "self-",
  "place-",
  "overflow-",
  "transition",
  "duration-",
  "ease-",
  "animate-",
  "cursor-",
  "select-",
  "sr-only",
  "not-sr-only",
  "hover:",
  "focus:",
  "active:",
  "disabled:",
  "dark:",
  "sm:",
  "md:",
  "lg:",
  "xl:",
  "2xl:",
] as const;

type StylingTechnology =
  | "plain-css"
  | "scss"
  | "sass"
  | "less"
  | "css-modules"
  | "tailwind-directives";

type ProjectStylingApproach =
  | "tailwind"
  | "css-modules"
  | "styled-components"
  | "emotion"
  | "vanilla-extract"
  | "stylex"
  | "plain-css"
  | "scss"
  | "sass"
  | "less"
  | "inline-styles"
  | "mixed";

type DesignTokenCategory =
  | "color"
  | "spacing"
  | "typography"
  | "border"
  | "shadow"
  | "size"
  | "z-index"
  | "animation"
  | "opacity"
  | "other";

interface ImportSymbol {
  readonly name: string;
  readonly alias?: string;
  readonly kind: string;
}

interface ImportEntry {
  readonly specifier: string;
  readonly resolvedPath?: string;
  readonly symbols: readonly ImportSymbol[];
  readonly isTypeOnly: boolean;
}

interface FileImportSummary {
  readonly externalPackages: ReadonlySet<string>;
  readonly imports: readonly ImportEntry[];
}

interface StylingImportIndex {
  readonly available: boolean;
  readonly byFile: ReadonlyMap<string, FileImportSummary>;
}

interface ProjectStylingConfig {
  readonly hasTailwindConfig: boolean;
  readonly tailwindConfigPath: string | null;
  readonly hasPostcssConfig: boolean;
  readonly postcssConfigPath: string | null;
  readonly stylingPackages: ReadonlySet<string>;
}

interface CustomPropertyInfo {
  readonly name: string;
  readonly line: number;
  readonly isDefinition: boolean;
}

interface SelectorInfo {
  readonly classCount: number;
  readonly idCount: number;
  readonly elementCount: number;
  readonly pseudoCount: number;
  readonly mediaQueryCount: number;
  readonly totalRuleCount: number;
}

interface StyleFileAnalysis {
  readonly filePath: string;
  readonly extension: string;
  readonly technology: StylingTechnology;
  readonly isCssModule: boolean;
  readonly customProperties: readonly CustomPropertyInfo[];
  readonly selectors: SelectorInfo;
  readonly tailwindDirectives: readonly string[];
  readonly importStatements: readonly string[];
  readonly size: number;
  readonly fileExists: boolean;
}

interface TailwindUsage {
  readonly detected: boolean;
  readonly classNameExpressions: number;
  readonly dynamicClassNames: number;
  readonly uniqueUtilityPrefixes: readonly string[];
  readonly estimatedClassCount: number;
}

interface StyledComponentsUsage {
  readonly detected: boolean;
  readonly styledCallCount: number;
  readonly cssCallCount: number;
  readonly createGlobalStyleCount: number;
  readonly componentNames: readonly string[];
}

interface EmotionUsage {
  readonly detected: boolean;
  readonly cssCallCount: number;
  readonly styledCallCount: number;
  readonly cxCallCount: number;
}

interface VanillaExtractUsage {
  readonly detected: boolean;
  readonly styleCallCount: number;
  readonly recipeCallCount: number;
  readonly globalStyleCallCount: number;
}

interface CssModuleImport {
  readonly localName: string;
  readonly specifier: string;
  readonly usageCount: number;
  readonly resolvedPath?: string;
}

interface CssModuleImportUsage {
  readonly detected: boolean;
  readonly moduleImports: readonly CssModuleImport[];
}

interface InlineStyleUsage {
  readonly detected: boolean;
  readonly styleJsxAttrCount: number;
  readonly styleObjectCount: number;
}

interface SourceFileAnalysis {
  readonly filePath: string;
  readonly tailwind: TailwindUsage;
  readonly styledComponents: StyledComponentsUsage;
  readonly emotion: EmotionUsage;
  readonly vanillaExtract: VanillaExtractUsage;
  readonly cssModuleImports: CssModuleImportUsage;
  readonly inlineStyles: InlineStyleUsage;
  readonly hasStyling: boolean;
  readonly fileExists: boolean;
}

interface DesignTokenPattern {
  readonly prefix: string;
  readonly count: number;
  readonly category: DesignTokenCategory;
}

interface ProjectStylingProfile {
  readonly primaryApproach: ProjectStylingApproach;
  readonly secondaryApproaches: readonly ProjectStylingApproach[];
  readonly technologyTally: Readonly<Record<ProjectStylingApproach, number>>;
  readonly customPropertyCount: number;
  readonly customPropertyNames: readonly string[];
  readonly designTokenPatterns: readonly DesignTokenPattern[];
  readonly cssModuleFileCount: number;
  readonly tailwindFileCount: number;
  readonly cssInJsFileCount: number;
  readonly plainCssFileCount: number;
  readonly preprocessorFileCount: number;
  readonly totalStyleFiles: number;
  readonly totalStyledSourceFiles: number;
  readonly hasTailwindConfig: boolean;
  readonly hasPostcssConfig: boolean;
}

export class StylingAnalyzer implements Analyzer {
  readonly name = "styling";
  readonly version = "1.0.0";
  readonly capabilities = [
    "tailwind-detection",
    "css-modules-detection",
    "css-in-js-detection",
    "design-token-detection",
    "styling-system-classification",
  ] as const;
  readonly dependencies = ["import"] as const;

  private runDiagnostics: AnalyzerDiagnostic[] = [];

  fileFilter(file: DiscoveredFile): boolean {
    return STYLING_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const startedAt = Date.now();
    this.runDiagnostics = [];

    const importIndex = this.buildImportIndex(context);
    if (!importIndex.available) {
      this.runDiagnostics.push({
        severity: "info",
        filePath: ".",
        message: "STY001 ImportAnalyzer output not available; CSS-in-JS detection limited to regex heuristics",
        line: 1,
        column: 0,
      });
    }

    const config = this.detectProjectConfig(context, importIndex);
    const sortedFiles = [...context.files].sort((a, b) =>
      compare(normalizeToPosix(a.relativePath), normalizeToPosix(b.relativePath)));

    const styleFiles = sortedFiles.filter((file) => STYLE_FILE_EXTENSIONS.has(file.extension));
    const sourceFiles = sortedFiles.filter((file) => SOURCE_STYLE_EXTENSIONS.has(file.extension));

    const styleResults: StyleFileAnalysis[] = [];
    const sourceResults: SourceFileAnalysis[] = [];

    for (const file of styleFiles) {
      if (context.signal?.aborted === true) {
        break;
      }
      styleResults.push(await this.analyzeStyleFile(file));
    }

    for (const file of sourceFiles) {
      if (context.signal?.aborted === true) {
        break;
      }
      sourceResults.push(await this.analyzeSourceFile(file, importIndex));
    }

    const profile = this.aggregateStylingProfile(styleResults, sourceResults, config);
    this.emitProfileDiagnostics(profile, config, sourceResults, styleResults);

    const patterns: PatternResult[] = [];
    for (const styleResult of styleResults) {
      if (!styleResult.fileExists) continue;
      patterns.push(this.buildStyleFilePattern(styleResult, config));
    }

    for (const sourceResult of sourceResults) {
      if (!sourceResult.fileExists) continue;
      const sourcePattern = this.buildSourceStylingPattern(sourceResult, config, importIndex);
      if (sourcePattern !== null) {
        patterns.push(sourcePattern);
      }
    }

    patterns.push(this.buildProjectProfilePattern(profile, styleResults.length + sourceResults.length));

    patterns.sort((a, b) => compare(a.id as string, b.id as string));

    const diagnostics = [...this.runDiagnostics].sort(compareDiagnostics);

    const hash = createHash("sha256")
      .update(stableStringify({ patterns, diagnostics }))
      .digest("hex");

    return {
      analyzerId: `${this.name}@${this.version}` as AnalyzerId,
      patterns,
      diagnostics,
      hash: hash as AnalyzerOutput["hash"],
      duration: Date.now() - startedAt,
      stats: {
        totalFiles: context.files.length,
        analyzedFiles: styleResults.length + sourceResults.length,
        cacheHits: 0,
        cacheMisses: styleResults.length + sourceResults.length,
      },
    };
  }

  private buildImportIndex(context: AnalyzerContext): StylingImportIndex {
    const importOutput = context.dependencyOutputs.get("import");
    if (importOutput === undefined) {
      return {
        available: false,
        byFile: new Map(),
      };
    }

    const byFile = new Map<string, FileImportSummary>();
    const sortedPatterns = [...importOutput.patterns].sort((a, b) =>
      compare(normalizeToPosix(a.filePath), normalizeToPosix(b.filePath)));

    for (const pattern of sortedPatterns) {
      const filePath = normalizeToPosix(pattern.filePath);
      const metadata = pattern.metadata;
      const externalPackages = readStringArray(metadata["externalPackages"]);
      const importEntries = this.readImportEntries(metadata["imports"]);

      byFile.set(filePath, {
        externalPackages: new Set(externalPackages),
        imports: importEntries,
      });
    }

    return {
      available: true,
      byFile,
    };
  }

  private readImportEntries(value: unknown): ImportEntry[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const entries: ImportEntry[] = [];

    for (const item of value) {
      if (!isRecord(item)) continue;
      const specifier = item["specifier"];
      if (typeof specifier !== "string") continue;

      const symbolsRaw = item["symbols"];
      const symbols: ImportSymbol[] = [];

      if (Array.isArray(symbolsRaw)) {
        for (const symbolRaw of symbolsRaw) {
          if (!isRecord(symbolRaw)) continue;
          const name = symbolRaw["name"];
          const kind = symbolRaw["kind"];
          if (typeof name !== "string" || typeof kind !== "string") continue;

          const alias = symbolRaw["alias"];
          symbols.push({
            name,
            kind,
            ...(typeof alias === "string" ? { alias } : {}),
          });
        }
      }

      const resolvedPath = item["resolvedPath"];
      const isTypeOnly = item["isTypeOnly"];

      entries.push({
        specifier,
        symbols: symbols.sort((a, b) =>
          compare(a.kind, b.kind) || compare(a.name, b.name) || compare(a.alias ?? "", b.alias ?? "")),
        ...(typeof resolvedPath === "string" ? { resolvedPath: normalizeToPosix(resolvedPath) } : {}),
        isTypeOnly: isTypeOnly === true,
      });
    }

    return entries.sort((a, b) =>
      compare(a.specifier, b.specifier) || compare(a.resolvedPath ?? "", b.resolvedPath ?? ""));
  }

  private detectProjectConfig(
    context: AnalyzerContext,
    importIndex: StylingImportIndex,
  ): ProjectStylingConfig {
    let hasTailwindConfig = false;
    let tailwindConfigPath: string | null = null;
    let hasPostcssConfig = false;
    let postcssConfigPath: string | null = null;

    for (const file of context.files) {
      const relativePath = normalizeToPosix(file.relativePath);
      const name = relativePath.split("/").pop()?.toLowerCase() ?? "";

      if (
        name === "tailwind.config.ts" ||
        name === "tailwind.config.js" ||
        name === "tailwind.config.mjs" ||
        name === "tailwind.config.cjs"
      ) {
        hasTailwindConfig = true;
        if (tailwindConfigPath === null) {
          tailwindConfigPath = relativePath;
        }
      }

      if (
        name === "postcss.config.ts" ||
        name === "postcss.config.js" ||
        name === "postcss.config.mjs" ||
        name === "postcss.config.cjs" ||
        name === ".postcssrc" ||
        name === ".postcssrc.json" ||
        name === ".postcssrc.yml" ||
        name === ".postcssrc.yaml" ||
        name === ".postcssrc.js"
      ) {
        hasPostcssConfig = true;
        if (postcssConfigPath === null) {
          postcssConfigPath = relativePath;
        }
      }
    }

    const stylingPackages = new Set<string>();
    for (const summary of importIndex.byFile.values()) {
      for (const pkg of summary.externalPackages) {
        if (isKnownStylingPackage(pkg)) {
          stylingPackages.add(pkg);
        }
      }
    }

    return {
      hasTailwindConfig,
      tailwindConfigPath,
      hasPostcssConfig,
      postcssConfigPath,
      stylingPackages,
    };
  }

  private async analyzeStyleFile(file: DiscoveredFile): Promise<StyleFileAnalysis> {
    const filePath = normalizeToPosix(file.relativePath);

    try {
      const content = await readFile(file.absolutePath, "utf-8");
      const extension = file.extension;
      const isCssModule = filePath.includes(".module.");
      const tailwindDirectives = extractAllMatches(content, /@tailwind\s+(?:base|components|utilities)|@apply\s+[^;]+;|@layer\s+(?:base|components|utilities)/g)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .sort(compare);

      const technology: StylingTechnology = isCssModule
        ? "css-modules"
        : tailwindDirectives.length > 0
        ? "tailwind-directives"
        : extension === "scss"
        ? "scss"
        : extension === "sass"
        ? "sass"
        : extension === "less"
        ? "less"
        : "plain-css";

      const customProperties = this.extractCustomProperties(content);
      const selectors = this.extractSelectorsAndClasses(content);
      const importStatements = extractAllMatches(content, /@(?:import|use)\s+[^;]+;/g)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .sort(compare);

      return {
        filePath,
        extension,
        technology,
        isCssModule,
        customProperties,
        selectors,
        tailwindDirectives,
        importStatements,
        size: content.length,
        fileExists: true,
      };
    } catch (error) {
      if (!isEnoent(error)) {
        this.runDiagnostics.push({
          severity: "warning",
          filePath,
          message: `STY007 Could not parse style file: ${errorMessage(error)}`,
          line: 1,
          column: 0,
        });
      }

      return {
        filePath,
        extension: file.extension,
        technology: "plain-css",
        isCssModule: filePath.includes(".module."),
        customProperties: [],
        selectors: {
          classCount: 0,
          idCount: 0,
          elementCount: 0,
          pseudoCount: 0,
          mediaQueryCount: 0,
          totalRuleCount: 0,
        },
        tailwindDirectives: [],
        importStatements: [],
        size: 0,
        fileExists: false,
      };
    }
  }

  private async analyzeSourceFile(
    file: DiscoveredFile,
    importIndex: StylingImportIndex,
  ): Promise<SourceFileAnalysis> {
    const filePath = normalizeToPosix(file.relativePath);

    try {
      const content = await readFile(file.absolutePath, "utf-8");
      const { sourceContent, styleBlocks } = extractSfcAwareContent(content, file.extension);
      const tailwind = this.detectTailwindUsage(sourceContent);
      const styledComponents = this.detectStyledComponents(sourceContent, importIndex, filePath);
      const emotion = this.detectEmotionUsage(sourceContent, importIndex, filePath);
      const vanillaExtract = this.detectVanillaExtract(sourceContent, importIndex, filePath);
      const cssModuleImports = this.detectCssModuleImports(sourceContent, importIndex, filePath, styleBlocks);
      const inlineStyles = this.detectInlineStyles(sourceContent);

      const hasStyling = tailwind.detected ||
        styledComponents.detected ||
        emotion.detected ||
        vanillaExtract.detected ||
        cssModuleImports.detected ||
        inlineStyles.detected;

      return {
        filePath,
        tailwind,
        styledComponents,
        emotion,
        vanillaExtract,
        cssModuleImports,
        inlineStyles,
        hasStyling,
        fileExists: true,
      };
    } catch (error) {
      if (!isEnoent(error)) {
        this.runDiagnostics.push({
          severity: "warning",
          filePath,
          message: `STY008 Could not parse source file: ${errorMessage(error)}`,
          line: 1,
          column: 0,
        });
      }

      return {
        filePath,
        tailwind: {
          detected: false,
          classNameExpressions: 0,
          dynamicClassNames: 0,
          uniqueUtilityPrefixes: [],
          estimatedClassCount: 0,
        },
        styledComponents: {
          detected: false,
          styledCallCount: 0,
          cssCallCount: 0,
          createGlobalStyleCount: 0,
          componentNames: [],
        },
        emotion: {
          detected: false,
          cssCallCount: 0,
          styledCallCount: 0,
          cxCallCount: 0,
        },
        vanillaExtract: {
          detected: false,
          styleCallCount: 0,
          recipeCallCount: 0,
          globalStyleCallCount: 0,
        },
        cssModuleImports: {
          detected: false,
          moduleImports: [],
        },
        inlineStyles: {
          detected: false,
          styleJsxAttrCount: 0,
          styleObjectCount: 0,
        },
        hasStyling: false,
        fileExists: false,
      };
    }
  }

  private extractCustomProperties(content: string): CustomPropertyInfo[] {
    const properties: CustomPropertyInfo[] = [];

    const defRegex = /(^|[\s;{])(--[A-Za-z0-9_-]+)\s*:/gm;
    for (const match of content.matchAll(defRegex)) {
      const name = match[2];
      const index = match.index;
      if (name === undefined || index === undefined) continue;
      properties.push({
        name,
        line: lineOfPos(content, index),
        isDefinition: true,
      });
    }

    const usageRegex = /var\(\s*(--[A-Za-z0-9_-]+)\s*[,)]/g;
    for (const match of content.matchAll(usageRegex)) {
      const name = match[1];
      const index = match.index;
      if (name === undefined || index === undefined) continue;
      properties.push({
        name,
        line: lineOfPos(content, index),
        isDefinition: false,
      });
    }

    return properties.sort((a, b) =>
      compare(a.name, b.name) ||
      (a.isDefinition === b.isDefinition ? 0 : a.isDefinition ? -1 : 1) ||
      a.line - b.line);
  }

  private extractSelectorsAndClasses(content: string): SelectorInfo {
    const classCount = countMatches(content, /\.[A-Za-z_-][A-Za-z0-9_-]*/g);
    const idCount = countMatches(content, /#[A-Za-z_-][A-Za-z0-9_-]*/g);
    const pseudoCount = countMatches(content, /::?[A-Za-z-]+/g);
    const mediaQueryCount = countMatches(content, /@media\b/g);
    const totalRuleCount = countMatches(content, /\{/g);

    const elementCount = countMatches(
      content,
      /(^|\s|,)(?:[a-z][a-z0-9-]*)(?=\s*[{,:.#[])/gm,
    );

    return {
      classCount,
      idCount,
      elementCount,
      pseudoCount,
      mediaQueryCount,
      totalRuleCount,
    };
  }

  private detectTailwindUsage(content: string): TailwindUsage {
    const classRegex = /\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{[^}]*\})/g;
    let classNameExpressions = 0;
    let estimatedClassCount = 0;
    const prefixes = new Set<string>();

    for (const match of content.matchAll(classRegex)) {
      classNameExpressions += 1;
      const classText = match[1] ?? match[2];
      if (classText === undefined) continue;

      const tokens = classText
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);

      for (const token of tokens) {
        if (!isTailwindUtilityToken(token)) continue;
        estimatedClassCount += 1;
        prefixes.add(extractTailwindPrefix(token));
      }
    }

    const dynamicClassNames = countMatches(content, /\b(?:clsx|cn|classnames|classNames|twMerge|cva)\s*\(/g);
    const detected = estimatedClassCount >= 3 || (estimatedClassCount > 0 && dynamicClassNames > 0);

    return {
      detected,
      classNameExpressions,
      dynamicClassNames,
      uniqueUtilityPrefixes: [...prefixes].sort(compare),
      estimatedClassCount,
    };
  }

  private detectStyledComponents(
    content: string,
    importIndex: StylingImportIndex,
    filePath: string,
  ): StyledComponentsUsage {
    const summary = importIndex.byFile.get(filePath);
    const hasStyledComponentsImport = summary?.externalPackages.has("styled-components") === true;

    const styledCallCount = countMatches(content, /styled(?:\.[a-z]\w*|\([A-Z]\w*\))\s*`/g);
    const cssCallCount = countMatches(content, /\bcss\s*`/g);
    const createGlobalStyleCount = countMatches(content, /createGlobalStyle\s*`/g);

    const componentNames = extractAllMatches(content, /(?:const|let|var)\s+([A-Z]\w*)\s*=\s*styled/g, 1)
      .sort(compare);

    const detectedSignal = styledCallCount + cssCallCount + createGlobalStyleCount > 0;
    const detected = detectedSignal && (hasStyledComponentsImport || !importIndex.available);

    return {
      detected,
      styledCallCount,
      cssCallCount,
      createGlobalStyleCount,
      componentNames,
    };
  }

  private detectEmotionUsage(
    content: string,
    importIndex: StylingImportIndex,
    filePath: string,
  ): EmotionUsage {
    const summary = importIndex.byFile.get(filePath);
    const hasEmotionImport = summary !== undefined && (
      summary.externalPackages.has("@emotion/react") ||
      summary.externalPackages.has("@emotion/styled") ||
      summary.externalPackages.has("@emotion/css")
    );

    const cssCallCount = countMatches(content, /\bcss\s*(?:`|\(|=)/g);
    const styledCallCount = countMatches(content, /styled(?:\.[a-z]\w*|\([A-Z]\w*\))\s*(?:`|\()/g);
    const cxCallCount = countMatches(content, /\bcx\s*\(/g);

    const detectedSignal = cssCallCount + styledCallCount + cxCallCount > 0;
    const detected = detectedSignal && (hasEmotionImport || !importIndex.available);

    return {
      detected,
      cssCallCount,
      styledCallCount,
      cxCallCount,
    };
  }

  private detectVanillaExtract(
    content: string,
    importIndex: StylingImportIndex,
    filePath: string,
  ): VanillaExtractUsage {
    const summary = importIndex.byFile.get(filePath);
    const hasVeImport = summary?.externalPackages.has("@vanilla-extract/css") === true;
    const isCssTsFile = filePath.endsWith(".css.ts");

    const styleCallCount = countMatches(content, /\bstyle\s*\(\s*\{/g);
    const recipeCallCount = countMatches(content, /\brecipe\s*\(\s*\{/g);
    const globalStyleCallCount = countMatches(content, /\bglobalStyle\s*\(/g);

    const detectedSignal = styleCallCount + recipeCallCount + globalStyleCallCount > 0;
    const detected = detectedSignal && (hasVeImport || isCssTsFile || !importIndex.available);

    return {
      detected,
      styleCallCount,
      recipeCallCount,
      globalStyleCallCount,
    };
  }

  private detectCssModuleImports(
    content: string,
    importIndex: StylingImportIndex,
    filePath: string,
    styleBlocks: readonly { attrs: string; content: string }[],
  ): CssModuleImportUsage {
    const moduleImports: CssModuleImport[] = [];
    const summary = importIndex.byFile.get(filePath);

    if (summary !== undefined) {
      for (const imp of summary.imports) {
        if (!isCssModuleSpecifier(imp.specifier)) continue;
        const localName = detectLocalBindingName(imp.symbols, imp.specifier);
        const usageCount = localName.length === 0
          ? 0
          : countMatches(content, new RegExp(`\\b${escapeRegExp(localName)}\\.\\w+`, "g"));

        moduleImports.push({
          localName,
          specifier: imp.specifier,
          usageCount,
          ...(imp.resolvedPath !== undefined ? { resolvedPath: imp.resolvedPath } : {}),
        });
      }
    }

    if (moduleImports.length === 0 && !importIndex.available) {
      const regex = /import\s+(\w+)\s+from\s+['"]([^'"]*\.module\.[^'"]+)['"]/g;
      for (const match of content.matchAll(regex)) {
        const localName = match[1] ?? "styles";
        const specifier = match[2] ?? "";
        const usageCount = countMatches(content, new RegExp(`\\b${escapeRegExp(localName)}\\.\\w+`, "g"));
        moduleImports.push({
          localName,
          specifier,
          usageCount,
        });
      }
    }

    for (const block of styleBlocks) {
      if (!/\bmodule\b/i.test(block.attrs)) continue;
      const usageCount = countMatches(content, /\$style\.\w+/g);
      moduleImports.push({
        localName: "$style",
        specifier: "<style module>",
        usageCount,
      });
    }

    const deduped = dedupeCssModuleImports(moduleImports);

    return {
      detected: deduped.length > 0,
      moduleImports: deduped,
    };
  }

  private detectInlineStyles(content: string): InlineStyleUsage {
    const styleJsxDoubleBrace = countMatches(content, /\bstyle\s*=\s*\{\s*\{/g);
    const styleJsxBinding = countMatches(content, /\bstyle\s*=\s*\{(?!\s*\{)/g);
    const styleVueBinding = countMatches(content, /:style\s*=\s*["'{]/g);
    const styleObjectCount = countMatches(content, /(?:const|let|var)\s+\w*[Ss]tyle\w*\s*=\s*\{/g);

    const styleJsxAttrCount = styleJsxDoubleBrace + styleJsxBinding + styleVueBinding;

    return {
      detected: styleJsxAttrCount > 0 || styleObjectCount > 0,
      styleJsxAttrCount,
      styleObjectCount,
    };
  }

  private aggregateStylingProfile(
    styleResults: readonly StyleFileAnalysis[],
    sourceResults: readonly SourceFileAnalysis[],
    config: ProjectStylingConfig,
  ): ProjectStylingProfile {
    const technologyTally = createTechnologyTally();

    let cssModuleFileCount = 0;
    let tailwindFileCount = 0;
    let cssInJsFileCount = 0;
    let plainCssFileCount = 0;
    let preprocessorFileCount = 0;

    const customPropertyNamesSet = new Set<string>();

    for (const style of styleResults) {
      if (!style.fileExists) continue;

      if (style.technology === "plain-css") {
        technologyTally["plain-css"] += 1;
        plainCssFileCount += 1;
      } else if (style.technology === "scss") {
        technologyTally["scss"] += 1;
        preprocessorFileCount += 1;
      } else if (style.technology === "sass") {
        technologyTally["sass"] += 1;
        preprocessorFileCount += 1;
      } else if (style.technology === "less") {
        technologyTally["less"] += 1;
        preprocessorFileCount += 1;
      } else if (style.technology === "css-modules") {
        technologyTally["css-modules"] += 1;
        cssModuleFileCount += 1;
      } else if (style.technology === "tailwind-directives") {
        technologyTally["tailwind"] += 1;
        tailwindFileCount += 1;
      }

      for (const customProperty of style.customProperties) {
        if (customProperty.isDefinition) {
          customPropertyNamesSet.add(customProperty.name);
        }
      }
    }

    let totalStyledSourceFiles = 0;
    for (const source of sourceResults) {
      if (!source.fileExists || !source.hasStyling) continue;
      totalStyledSourceFiles += 1;

      let activeApproaches = 0;

      if (source.tailwind.detected) {
        technologyTally["tailwind"] += 1;
        tailwindFileCount += 1;
        activeApproaches += 1;
      }
      if (source.cssModuleImports.detected) {
        technologyTally["css-modules"] += 1;
        cssModuleFileCount += 1;
        activeApproaches += 1;
      }
      if (source.styledComponents.detected) {
        technologyTally["styled-components"] += 1;
        cssInJsFileCount += 1;
        activeApproaches += 1;
      }
      if (source.emotion.detected) {
        technologyTally["emotion"] += 1;
        cssInJsFileCount += 1;
        activeApproaches += 1;
      }
      if (source.vanillaExtract.detected) {
        technologyTally["vanilla-extract"] += 1;
        cssInJsFileCount += 1;
        activeApproaches += 1;
      }
      if (source.inlineStyles.detected) {
        technologyTally["inline-styles"] += 1;
        activeApproaches += 1;
      }
      if (activeApproaches >= 3) {
        technologyTally["mixed"] += 1;
      }
    }

    const customPropertyNames = [...customPropertyNamesSet].sort(compare);
    const designTokenPatterns = buildDesignTokenPatterns(customPropertyNames);

    const nonZeroApproaches = Object.entries(technologyTally)
      .filter((entry): entry is [ProjectStylingApproach, number] => entry[1] > 0)
      .sort((a, b) => b[1] - a[1] || compare(a[0], b[0]));

    const primaryApproach = nonZeroApproaches.length === 0
      ? "plain-css"
      : nonZeroApproaches[0]![0];

    const secondaryApproaches = nonZeroApproaches
      .map((entry) => entry[0])
      .filter((approach) => approach !== primaryApproach)
      .sort(compare);

    return {
      primaryApproach,
      secondaryApproaches,
      technologyTally,
      customPropertyCount: customPropertyNames.length,
      customPropertyNames,
      designTokenPatterns,
      cssModuleFileCount,
      tailwindFileCount,
      cssInJsFileCount,
      plainCssFileCount,
      preprocessorFileCount,
      totalStyleFiles: styleResults.filter((style) => style.fileExists).length,
      totalStyledSourceFiles,
      hasTailwindConfig: config.hasTailwindConfig,
      hasPostcssConfig: config.hasPostcssConfig,
    };
  }

  private emitProfileDiagnostics(
    profile: ProjectStylingProfile,
    config: ProjectStylingConfig,
    sourceResults: readonly SourceFileAnalysis[],
    styleResults: readonly StyleFileAnalysis[],
  ): void {
    const activeApproaches = Object.entries(profile.technologyTally)
      .filter((entry) => entry[1] > 0)
      .map((entry) => entry[0])
      .sort(compare);

    if (activeApproaches.length >= 3) {
      this.runDiagnostics.push({
        severity: "info",
        filePath: ".",
        message: `STY002 Mixed styling approaches: ${activeApproaches.join(", ")}`,
        line: 1,
        column: 0,
      });
    }

    for (const pattern of profile.designTokenPatterns) {
      this.runDiagnostics.push({
        severity: "info",
        filePath: ".",
        message: `STY003 Design token pattern: ${pattern.count} tokens with prefix "${pattern.prefix}" (${pattern.category})`,
        line: 1,
        column: 0,
      });
    }

    for (const source of sourceResults) {
      if (!source.fileExists) continue;
      const hasSystem = source.tailwind.detected ||
        source.cssModuleImports.detected ||
        source.styledComponents.detected ||
        source.emotion.detected ||
        source.vanillaExtract.detected;

      if (source.inlineStyles.detected && hasSystem && profile.primaryApproach !== "inline-styles") {
        this.runDiagnostics.push({
          severity: "warning",
          filePath: source.filePath,
          message: `STY004 Inline styles in "${source.filePath}" alongside ${profile.primaryApproach}; consider using the project's styling system`,
          line: 1,
          column: 0,
        });
      }
    }

    const importedCssModules = new Set<string>();
    for (const source of sourceResults) {
      for (const moduleImport of source.cssModuleImports.moduleImports) {
        if (moduleImport.resolvedPath !== undefined) {
          importedCssModules.add(normalizeToPosix(moduleImport.resolvedPath));
        }
      }
    }

    for (const style of styleResults) {
      if (!style.fileExists || !style.isCssModule) continue;

      const imported = importedCssModules.has(style.filePath);
      if (!imported) {
        this.runDiagnostics.push({
          severity: "info",
          filePath: style.filePath,
          message: `STY005 CSS Module "${style.filePath}" has no detected import in source files`,
          line: 1,
          column: 0,
        });
      }
    }

    if (config.hasTailwindConfig && profile.tailwindFileCount === 0) {
      this.runDiagnostics.push({
        severity: "warning",
        filePath: ".",
        message: "STY006 tailwind.config found but no Tailwind utility classes detected in source files",
        line: 1,
        column: 0,
      });
    }
  }

  private buildStyleFilePattern(
    analysis: StyleFileAnalysis,
    config: ProjectStylingConfig,
  ): PatternResult {
    const contentScore = analysis.selectors.totalRuleCount > 0 ? 0.8 : 0.3;
    const configScore = scoreStyleFileAgainstConfig(analysis.technology, config);

    const factors = [
      { name: "file-extension", weight: 0.4, score: 1.0 },
      { name: "content-analysis", weight: 0.4, score: contentScore },
      { name: "config-corroboration", weight: 0.2, score: configScore },
    ];

    const confidence = factors.reduce((sum, factor) => sum + factor.weight * factor.score, 0);

    const customPropertyDefinitions = analysis.customProperties
      .filter((property) => property.isDefinition)
      .map((property) => property.name)
      .sort(compare);

    const customPropertyUsages = analysis.customProperties
      .filter((property) => !property.isDefinition)
      .map((property) => property.name)
      .sort(compare);

    return {
      id: `${analysis.filePath}:stylesheet:1` as PatternId,
      type: "utility",
      name: "stylesheet",
      filePath: analysis.filePath,
      location: {
        file: analysis.filePath,
        start: { line: 1, column: 0 },
        end: { line: 1, column: 0 },
      },
      confidence: {
        value: confidence,
        source: "styling-analysis",
        factors,
      },
      framework: "unknown",
      dependencies: [],
      properties: {},
      metadata: {
        technology: analysis.technology,
        isCssModule: analysis.isCssModule,
        classCount: analysis.selectors.classCount,
        idCount: analysis.selectors.idCount,
        elementCount: analysis.selectors.elementCount,
        pseudoCount: analysis.selectors.pseudoCount,
        mediaQueryCount: analysis.selectors.mediaQueryCount,
        totalRuleCount: analysis.selectors.totalRuleCount,
        customPropertyDefinitions,
        customPropertyUsages,
        tailwindDirectives: analysis.tailwindDirectives,
        importStatements: analysis.importStatements,
        size: analysis.size,
      },
    };
  }

  private buildSourceStylingPattern(
    analysis: SourceFileAnalysis,
    config: ProjectStylingConfig,
    importIndex: StylingImportIndex,
  ): PatternResult | null {
    if (!analysis.hasStyling) {
      return null;
    }

    const summary = importIndex.byFile.get(analysis.filePath);
    const hasImportSignal = summary !== undefined && (
      summary.externalPackages.has("tailwindcss") ||
      summary.externalPackages.has("styled-components") ||
      summary.externalPackages.has("@emotion/react") ||
      summary.externalPackages.has("@emotion/styled") ||
      summary.externalPackages.has("@emotion/css") ||
      summary.externalPackages.has("@vanilla-extract/css") ||
      analysis.cssModuleImports.detected
    );

    const importScore = hasImportSignal
      ? 1
      : !importIndex.available && analysis.hasStyling
      ? 0.6
      : 0;

    const usageInstances = analysis.tailwind.estimatedClassCount +
      analysis.tailwind.dynamicClassNames +
      analysis.styledComponents.styledCallCount +
      analysis.styledComponents.cssCallCount +
      analysis.styledComponents.createGlobalStyleCount +
      analysis.emotion.cssCallCount +
      analysis.emotion.styledCallCount +
      analysis.emotion.cxCallCount +
      analysis.vanillaExtract.styleCallCount +
      analysis.vanillaExtract.recipeCallCount +
      analysis.vanillaExtract.globalStyleCallCount +
      analysis.inlineStyles.styleJsxAttrCount +
      analysis.inlineStyles.styleObjectCount;

    const usageScore = usageInstances >= 5
      ? 1
      : usageInstances <= 0
      ? 0
      : 0.2 + ((usageInstances - 1) / 4) * 0.6;

    const configScore = config.hasTailwindConfig && analysis.tailwind.detected ? 1 : 0.5;

    const factors = [
      { name: "import-signal", weight: 0.5, score: importScore },
      { name: "usage-signal", weight: 0.3, score: usageScore },
      { name: "config-corroboration", weight: 0.2, score: configScore },
    ];

    const confidence = factors.reduce((sum, factor) => sum + factor.weight * factor.score, 0);

    return {
      id: `${analysis.filePath}:styling:1` as PatternId,
      type: "utility",
      name: "styling",
      filePath: analysis.filePath,
      location: {
        file: analysis.filePath,
        start: { line: 1, column: 0 },
        end: { line: 1, column: 0 },
      },
      confidence: {
        value: confidence,
        source: "styling-analysis",
        factors,
      },
      framework: "unknown",
      dependencies: [],
      properties: {},
      metadata: {
        tailwind: analysis.tailwind.detected,
        "styled-components": analysis.styledComponents.detected,
        emotion: analysis.emotion.detected,
        "vanilla-extract": analysis.vanillaExtract.detected,
        "css-modules": analysis.cssModuleImports.detected,
        "inline-styles": analysis.inlineStyles.detected,
        tailwindClassCount: analysis.tailwind.estimatedClassCount,
        tailwindDynamicClassCount: analysis.tailwind.dynamicClassNames,
        tailwindUtilityPrefixes: analysis.tailwind.uniqueUtilityPrefixes,
        cssModuleBindings: analysis.cssModuleImports.moduleImports,
        styledCallCount: analysis.styledComponents.styledCallCount,
        styledCssCallCount: analysis.styledComponents.cssCallCount,
        styledComponentNames: analysis.styledComponents.componentNames,
        emotionCssCallCount: analysis.emotion.cssCallCount,
        emotionStyledCallCount: analysis.emotion.styledCallCount,
        emotionCxCallCount: analysis.emotion.cxCallCount,
        vanillaExtractStyleCallCount: analysis.vanillaExtract.styleCallCount,
        vanillaExtractRecipeCallCount: analysis.vanillaExtract.recipeCallCount,
        vanillaExtractGlobalStyleCallCount: analysis.vanillaExtract.globalStyleCallCount,
        inlineStyleCount: analysis.inlineStyles.styleJsxAttrCount,
        styleObjectCount: analysis.inlineStyles.styleObjectCount,
      },
    };
  }

  private buildProjectProfilePattern(
    profile: ProjectStylingProfile,
    totalAnalyzedFiles: number,
  ): PatternResult {
    const totalStyledFiles =
      profile.totalStyleFiles +
      profile.totalStyledSourceFiles;

    const dominantFileCount =
      profile.technologyTally[profile.primaryApproach] ?? 0;

    const sampleScore = Math.min(1, totalAnalyzedFiles / 10);
    const consistencyScore = totalStyledFiles === 0
      ? 0
      : dominantFileCount / totalStyledFiles;
    const configScore = profile.hasTailwindConfig || profile.hasPostcssConfig ? 1 : 0.3;

    const factors = [
      { name: "sample-size", weight: 0.4, score: sampleScore },
      { name: "technology-consistency", weight: 0.3, score: consistencyScore },
      { name: "config-presence", weight: 0.3, score: configScore },
    ];

    const confidence = factors.reduce((sum, factor) => sum + factor.weight * factor.score, 0);

    return {
      id: ".:styling-profile:1" as PatternId,
      type: "utility",
      name: "styling-profile",
      filePath: ".",
      location: {
        file: ".",
        start: { line: 1, column: 0 },
        end: { line: 1, column: 0 },
      },
      confidence: {
        value: confidence,
        source: "styling-analysis",
        factors,
      },
      framework: "unknown",
      dependencies: [],
      properties: {},
      metadata: {
        primaryApproach: profile.primaryApproach,
        secondaryApproaches: profile.secondaryApproaches,
        technologyTally: profile.technologyTally,
        customPropertyCount: profile.customPropertyCount,
        customPropertyNames: profile.customPropertyNames,
        designTokenPatterns: profile.designTokenPatterns,
        cssModuleFileCount: profile.cssModuleFileCount,
        tailwindFileCount: profile.tailwindFileCount,
        cssInJsFileCount: profile.cssInJsFileCount,
        plainCssFileCount: profile.plainCssFileCount,
        preprocessorFileCount: profile.preprocessorFileCount,
        totalStyleFiles: profile.totalStyleFiles,
        totalStyledSourceFiles: profile.totalStyledSourceFiles,
        hasTailwindConfig: profile.hasTailwindConfig,
        hasPostcssConfig: profile.hasPostcssConfig,
      },
    };
  }
}

function createTechnologyTally(): Record<ProjectStylingApproach, number> {
  return {
    tailwind: 0,
    "css-modules": 0,
    "styled-components": 0,
    emotion: 0,
    "vanilla-extract": 0,
    stylex: 0,
    "plain-css": 0,
    scss: 0,
    sass: 0,
    less: 0,
    "inline-styles": 0,
    mixed: 0,
  };
}

function compareDiagnostics(a: AnalyzerDiagnostic, b: AnalyzerDiagnostic): number {
  return compare(a.filePath, b.filePath) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    compare(a.severity, b.severity) ||
    compare(a.message, b.message);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").sort(compare);
}

function extractAllMatches(content: string, regex: RegExp, group = 0): string[] {
  const values: string[] = [];
  for (const match of content.matchAll(regex)) {
    const value = match[group];
    if (typeof value === "string") {
      values.push(value);
    }
  }
  return values;
}

function countMatches(content: string, regex: RegExp): number {
  let count = 0;
  for (const _ of content.matchAll(regex)) {
    count += 1;
  }
  return count;
}

function lineOfPos(content: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function isTailwindUtilityToken(token: string): boolean {
  const normalized = token.trim();
  if (normalized.length === 0) return false;

  const withoutVariants = normalized.split(":").pop() ?? normalized;
  const withoutNegation = withoutVariants.startsWith("-")
    ? withoutVariants.slice(1)
    : withoutVariants;

  for (const prefix of TAILWIND_PREFIXES) {
    if (withoutNegation === prefix || withoutNegation.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function extractTailwindPrefix(token: string): string {
  const lastSegment = token.split(":").pop() ?? token;
  const normalized = lastSegment.startsWith("-") ? lastSegment.slice(1) : lastSegment;

  const dashIndex = normalized.indexOf("-");
  if (dashIndex === -1) {
    return normalized;
  }
  return normalized.slice(0, dashIndex);
}

function isKnownStylingPackage(pkg: string): boolean {
  return pkg === "tailwindcss" ||
    pkg === "styled-components" ||
    pkg === "@emotion/react" ||
    pkg === "@emotion/styled" ||
    pkg === "@emotion/css" ||
    pkg === "@vanilla-extract/css" ||
    pkg === "@stylex.js/stylex" ||
    pkg === "@stylexjs/stylex" ||
    pkg === "@stitches/react" ||
    pkg === "@stitches/core" ||
    pkg === "linaria" ||
    pkg === "@linaria/core";
}

function isCssModuleSpecifier(specifier: string): boolean {
  const normalized = specifier.toLowerCase();
  return CSS_MODULE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function detectLocalBindingName(
  symbols: readonly ImportSymbol[],
  specifier: string,
): string {
  for (const symbol of symbols) {
    if (symbol.kind === "default" && typeof symbol.alias === "string") {
      return symbol.alias;
    }
  }

  for (const symbol of symbols) {
    if (symbol.kind === "namespace" && typeof symbol.alias === "string") {
      return symbol.alias;
    }
  }

  for (const symbol of symbols) {
    if (symbol.kind === "named") {
      return symbol.alias ?? symbol.name;
    }
  }

  const fileName = specifier.split("/").pop() ?? "styles";
  const base = fileName.replace(/\.[^.]+$/g, "");
  return base.replace(/[^A-Za-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase()) || "styles";
}

function dedupeCssModuleImports(imports: readonly CssModuleImport[]): CssModuleImport[] {
  const map = new Map<string, CssModuleImport>();

  for (const item of imports) {
    const key = `${item.localName}|${item.specifier}|${item.resolvedPath ?? ""}`;
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, item);
      continue;
    }

    if (item.usageCount > existing.usageCount) {
      map.set(key, item);
    }
  }

  return [...map.values()].sort((a, b) =>
    compare(a.localName, b.localName) ||
    compare(a.specifier, b.specifier) ||
    compare(a.resolvedPath ?? "", b.resolvedPath ?? ""));
}

function buildDesignTokenPatterns(
  customPropertyNames: readonly string[],
): DesignTokenPattern[] {
  const groupMap = new Map<string, string[]>();

  for (const name of customPropertyNames) {
    const prefix = detectTokenPrefix(name);
    const items = groupMap.get(prefix);
    if (items === undefined) {
      groupMap.set(prefix, [name]);
    } else {
      items.push(name);
    }
  }

  const patterns: DesignTokenPattern[] = [];
  for (const [prefix, names] of [...groupMap.entries()].sort((a, b) => compare(a[0], b[0]))) {
    if (names.length < 2) continue;
    patterns.push({
      prefix,
      count: names.length,
      category: classifyTokenCategory(prefix),
    });
  }

  return patterns.sort((a, b) =>
    b.count - a.count || compare(a.prefix, b.prefix));
}

function detectTokenPrefix(name: string): string {
  const parts = name.split("-").filter((item) => item.length > 0);
  if (parts.length <= 1) return name;
  return `--${parts[1]}`;
}

function classifyTokenCategory(prefix: string): DesignTokenCategory {
  if (
    prefix.startsWith("--color") ||
    prefix.startsWith("--bg") ||
    prefix.startsWith("--fg") ||
    prefix.startsWith("--border-color")
  ) {
    return "color";
  }
  if (
    prefix.startsWith("--spacing") ||
    prefix.startsWith("--space") ||
    prefix.startsWith("--gap") ||
    prefix.startsWith("--padding") ||
    prefix.startsWith("--margin")
  ) {
    return "spacing";
  }
  if (
    prefix.startsWith("--font") ||
    prefix.startsWith("--text") ||
    prefix.startsWith("--line-height") ||
    prefix.startsWith("--letter-spacing")
  ) {
    return "typography";
  }
  if (
    prefix.startsWith("--border") ||
    prefix.startsWith("--radius") ||
    prefix.startsWith("--outline")
  ) {
    return "border";
  }
  if (prefix.startsWith("--shadow") || prefix.startsWith("--box-shadow")) {
    return "shadow";
  }
  if (
    prefix.startsWith("--size") ||
    prefix.startsWith("--width") ||
    prefix.startsWith("--height") ||
    prefix.startsWith("--max-width")
  ) {
    return "size";
  }
  if (prefix.startsWith("--z") || prefix.startsWith("--z-index")) {
    return "z-index";
  }
  if (
    prefix.startsWith("--animation") ||
    prefix.startsWith("--transition") ||
    prefix.startsWith("--duration")
  ) {
    return "animation";
  }
  if (prefix.startsWith("--opacity")) {
    return "opacity";
  }

  return "other";
}

function scoreStyleFileAgainstConfig(
  technology: StylingTechnology,
  config: ProjectStylingConfig,
): number {
  if (technology === "tailwind-directives") {
    if (config.hasTailwindConfig || config.stylingPackages.has("tailwindcss")) {
      return 1;
    }
    return 0.3;
  }

  if (technology === "scss" || technology === "sass") {
    return config.stylingPackages.has("sass") ? 1 : 0.5;
  }

  if (technology === "less") {
    return config.stylingPackages.has("less") ? 1 : 0.5;
  }

  return 0.5;
}

function extractSfcAwareContent(
  content: string,
  extension: string,
): {
  readonly sourceContent: string;
  readonly styleBlocks: readonly { attrs: string; content: string }[];
} {
  if (extension === "vue") {
    return extractVueBlocks(content);
  }

  if (extension === "svelte") {
    return extractSvelteBlocks(content);
  }

  return {
    sourceContent: content,
    styleBlocks: [],
  };
}

function extractVueBlocks(content: string): {
  readonly sourceContent: string;
  readonly styleBlocks: readonly { attrs: string; content: string }[];
} {
  const templateBlocks = extractAllMatches(content, /<template[^>]*>([\s\S]*?)<\/template>/gi, 1);
  const scriptBlocks = extractAllMatches(content, /<script[^>]*>([\s\S]*?)<\/script>/gi, 1);

  const styleBlocks: { attrs: string; content: string }[] = [];
  const styleRegex = /<style([^>]*)>([\s\S]*?)<\/style>/gi;
  for (const match of content.matchAll(styleRegex)) {
    const attrs = match[1] ?? "";
    const blockContent = match[2] ?? "";
    styleBlocks.push({ attrs, content: blockContent });
  }

  return {
    sourceContent: [...templateBlocks, ...scriptBlocks].join("\n"),
    styleBlocks: styleBlocks.sort((a, b) => compare(a.attrs, b.attrs) || compare(a.content, b.content)),
  };
}

function extractSvelteBlocks(content: string): {
  readonly sourceContent: string;
  readonly styleBlocks: readonly { attrs: string; content: string }[];
} {
  const styleBlocks: { attrs: string; content: string }[] = [];
  const styleRegex = /<style([^>]*)>([\s\S]*?)<\/style>/gi;

  let sourceContent = content;
  for (const match of content.matchAll(styleRegex)) {
    const attrs = match[1] ?? "";
    const blockContent = match[2] ?? "";
    styleBlocks.push({ attrs, content: blockContent });

    const fullMatch = match[0] ?? "";
    sourceContent = sourceContent.replace(fullMatch, "");
  }

  return {
    sourceContent,
    styleBlocks: styleBlocks.sort((a, b) => compare(a.attrs, b.attrs) || compare(a.content, b.content)),
  };
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
