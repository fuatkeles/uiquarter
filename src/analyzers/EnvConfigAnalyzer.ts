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
  CacheKey,
  DiscoveredFile,
  FileHash,
  PatternId,
  PatternResult,
  PatternType,
  OutputHash,
} from "../types/index.js";

// -----------------------------------------------------------------------------
// Constants & Regex
// -----------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set(["ts", "js"]);

/** .env file line parsing: KEY=VALUE (ignoring comments and empty lines) */
const ENV_LINE_RE = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)/gm;

/** process.env usage */
const PROCESS_ENV_RE = /process\.env\.([A-Z_][A-Z0-9_]*)/g;

/** import.meta.env usage (Vite) */
const IMPORT_META_ENV_RE = /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;

/** Secret variable name patterns */
const SECRET_NAME_RE = /(?:SECRET|KEY|PASSWORD|TOKEN|PRIVATE|CREDENTIAL|API_KEY|AUTH)/i;

/** Zod env validation patterns */
const ZOD_ENV_RE = /z\.object\s*\(\s*\{[\s\S]*?\}\s*\)/g;
const ZOD_IMPORT_RE = /from\s+['"]zod['"]/;

/** Hardcoded secret patterns (value looks like a secret in source code) */
const HARDCODED_SECRET_RE = /(?:secret|password|token|apiKey|api_key|private_key)\s*[:=]\s*['"][^'"]{8,}['"]/gi;

/** T3 env / env validation libraries */
const T3_ENV_RE = /from\s+['"]@t3-oss\/env/;
const ENVALID_RE = /from\s+['"]envalid['"]/;

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

interface EnvVariable {
  readonly name: string;
  readonly isSecret: boolean;
  readonly source: "env-file" | "process-env" | "import-meta-env";
}

interface EnvFileMetrics {
  readonly filePath: string;
  readonly isEnvFile: boolean;
  readonly isEnvExample: boolean;
  readonly variables: readonly EnvVariable[];
  readonly hasZodValidation: boolean;
  readonly hasT3Env: boolean;
  readonly hasEnvalid: boolean;
  readonly hardcodedSecretCount: number;
}

// -----------------------------------------------------------------------------
// EnvConfigAnalyzer
// -----------------------------------------------------------------------------

export class EnvConfigAnalyzer implements Analyzer {
  readonly name = "env-config";
  readonly version = "1.0.0";
  readonly capabilities = [
    "env-file-parsing",
    "env-usage-detection",
    "secret-detection",
    "validation-detection",
    "hardcoded-secret-detection",
  ] as const;
  readonly dependencies = [] as const;

  fileFilter(file: DiscoveredFile): boolean {
    const normPath = file.relativePath.replace(/\\/g, "/");
    const fileName = normPath.split("/").pop() ?? "";

    // Match .env files (any variant)
    if (fileName.startsWith(".env")) return true;

    // Match config files with env in the name
    if (CODE_EXTENSIONS.has(file.extension)) {
      if (/env/i.test(fileName) || /config/i.test(fileName)) return true;
      // Also check any ts/js file for env usage (will be quick-filtered in analysis)
      return true;
    }

    return false;
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [];
    const allMetrics: EnvFileMetrics[] = [];
    let cacheHits = 0;

    for (const file of context.files) {
      if (context.signal?.aborted) break;

      const cacheKey = `env-config:${file.relativePath}:${file.hash as string}` as CacheKey;
      const cached = context.cache.get<EnvFileMetrics>(cacheKey);
      if (cached !== undefined) {
        allMetrics.push(cached.value);
        cacheHits++;
        continue;
      }

      let content: string;
      try {
        content = await readFile(
          posix.join(context.rootPath, file.relativePath.replace(/\\/g, "/")),
          "utf-8",
        );
      } catch {
        try {
          const { join } = await import("node:path");
          content = await readFile(join(context.rootPath, file.relativePath), "utf-8");
        } catch {
          continue;
        }
      }

      const metrics = analyzeEnvFile(file, content);
      // Skip files with no env signals
      if (metrics.variables.length === 0 && !metrics.isEnvFile && !metrics.hasZodValidation && !metrics.hasT3Env && !metrics.hasEnvalid && metrics.hardcodedSecretCount === 0) {
        continue;
      }
      allMetrics.push(metrics);
      context.cache.set(cacheKey, metrics, file.hash as FileHash);
    }

    // Aggregate
    const allVarNames = new Set<string>();
    const secretVarNames = new Set<string>();
    let hasEnvExample = false;
    let hasValidation = false;
    let validationLib: string | null = null;
    let totalHardcodedSecrets = 0;

    for (const m of allMetrics) {
      if (m.isEnvExample) hasEnvExample = true;
      if (m.hasZodValidation || m.hasT3Env || m.hasEnvalid) {
        hasValidation = true;
        if (m.hasT3Env) validationLib = "t3-env";
        else if (m.hasEnvalid) validationLib = "envalid";
        else if (m.hasZodValidation) validationLib = "zod";
      }
      totalHardcodedSecrets += m.hardcodedSecretCount;
      for (const v of m.variables) {
        allVarNames.add(v.name);
        if (v.isSecret) secretVarNames.add(v.name);
      }
    }

    // Per-file patterns
    for (const m of allMetrics) {
      if (m.variables.length === 0 && !m.isEnvFile) continue;

      const pid = `${m.filePath}:env:1` as PatternId;
      patterns.push({
        id: pid,
        type: "utility" as PatternType,
        name: m.isEnvFile ? `env-file:${extractFileName(m.filePath)}` : `env-usage:${extractFileName(m.filePath)}`,
        filePath: m.filePath,
        location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
        confidence: {
          value: m.isEnvFile ? 0.95 : 0.8,
          source: "env-detection",
          factors: [{ name: m.isEnvFile ? "env-file" : "env-usage", weight: 1, score: m.isEnvFile ? 0.95 : 0.8 }],
        },
        framework: "generic",
        dependencies: [],
        properties: {},
        metadata: {
          isEnvFile: m.isEnvFile,
          isEnvExample: m.isEnvExample,
          variableCount: m.variables.length,
          secretCount: m.variables.filter((v) => v.isSecret).length,
          hasValidation: m.hasZodValidation || m.hasT3Env || m.hasEnvalid,
        },
      });

      // ENV003: hardcoded secret in source
      if (m.hardcodedSecretCount > 0 && !m.isEnvFile) {
        diagnostics.push({
          severity: "warning",
          filePath: m.filePath,
          message: `ENV003 Found ${m.hardcodedSecretCount} potential hardcoded secret(s) in source file.`,
        });
      }
    }

    // ENV001: secret without .env.example
    if (secretVarNames.size > 0 && !hasEnvExample) {
      diagnostics.push({
        severity: "warning",
        filePath: ".",
        message: `ENV001 Found ${secretVarNames.size} secret env variable(s) but no .env.example file exists.`,
      });
    }

    // ENV002: env without validation
    if (allVarNames.size > 0 && !hasValidation) {
      diagnostics.push({
        severity: "info",
        filePath: ".",
        message: `ENV002 Found ${allVarNames.size} env variable(s) but no schema validation (zod, envalid, t3-env) detected.`,
      });
    }

    // Summary pattern
    const summaryId = `.:env-config-summary:1` as PatternId;
    patterns.push({
      id: summaryId,
      type: "utility" as PatternType,
      name: "env-config-summary",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: 0.9,
        source: "env-analysis",
        factors: [{ name: "env-detection", weight: 1, score: 0.9 }],
      },
      framework: "generic",
      dependencies: [],
      properties: {},
      metadata: {
        totalVariables: allVarNames.size,
        secretCount: secretVarNames.size,
        hasEnvExample: hasEnvExample,
        hasValidation,
        validationLibrary: validationLib,
        totalHardcodedSecrets,
        envFiles: allMetrics.filter((m) => m.isEnvFile).length,
      },
    });

    // Sort for determinism
    patterns.sort((a, b) => compare(a.id as string, b.id as string));
    diagnostics.sort((a, b) => compare(a.message, b.message));

    const duration = Date.now() - start;
    const hash = computeOutputHash(patterns, diagnostics);

    return {
      analyzerId: `${this.name}@${this.version}` as AnalyzerId,
      patterns,
      diagnostics,
      hash,
      duration,
      stats: {
        totalFiles: context.files.length,
        analyzedFiles: allMetrics.length,
        cacheHits,
        cacheMisses: allMetrics.length - cacheHits,
      },
    };
  }
}

// -----------------------------------------------------------------------------
// Per-file analysis
// -----------------------------------------------------------------------------

function analyzeEnvFile(file: DiscoveredFile, content: string): EnvFileMetrics {
  const normPath = file.relativePath.replace(/\\/g, "/");
  const fileName = normPath.split("/").pop() ?? "";
  const isEnvFile = fileName.startsWith(".env");
  const isEnvExample = fileName === ".env.example" || fileName === ".env.sample" || fileName === ".env.template";

  const variables: EnvVariable[] = [];

  if (isEnvFile) {
    // Parse KEY=VALUE pairs
    const envLineRe = new RegExp(ENV_LINE_RE.source, ENV_LINE_RE.flags);
    let match: RegExpExecArray | null;
    while ((match = envLineRe.exec(content)) !== null) {
      const name = match[1]!;
      variables.push({
        name,
        isSecret: SECRET_NAME_RE.test(name),
        source: "env-file",
      });
    }
  } else {
    // Parse process.env.XXX usage
    const procEnvRe = new RegExp(PROCESS_ENV_RE.source, PROCESS_ENV_RE.flags);
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((match = procEnvRe.exec(content)) !== null) {
      const name = match[1]!;
      if (!seen.has(name)) {
        seen.add(name);
        variables.push({
          name,
          isSecret: SECRET_NAME_RE.test(name),
          source: "process-env",
        });
      }
    }

    // Parse import.meta.env.XXX usage
    const metaEnvRe = new RegExp(IMPORT_META_ENV_RE.source, IMPORT_META_ENV_RE.flags);
    while ((match = metaEnvRe.exec(content)) !== null) {
      const name = match[1]!;
      if (!seen.has(name)) {
        seen.add(name);
        variables.push({
          name,
          isSecret: SECRET_NAME_RE.test(name),
          source: "import-meta-env",
        });
      }
    }
  }

  // Zod validation
  const hasZodValidation = ZOD_IMPORT_RE.test(content) && new RegExp(ZOD_ENV_RE.source, ZOD_ENV_RE.flags).test(content);

  // T3 env
  const hasT3Env = T3_ENV_RE.test(content);

  // Envalid
  const hasEnvalid = ENVALID_RE.test(content);

  // Hardcoded secrets
  const hardcodedRe = new RegExp(HARDCODED_SECRET_RE.source, HARDCODED_SECRET_RE.flags);
  let hardcodedSecretCount = 0;
  if (!isEnvFile) {
    while (hardcodedRe.exec(content) !== null) hardcodedSecretCount++;
  }

  return {
    filePath: file.relativePath,
    isEnvFile,
    isEnvExample,
    variables,
    hasZodValidation,
    hasT3Env,
    hasEnvalid,
    hardcodedSecretCount,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function extractFileName(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  const fileName = parts[parts.length - 1] ?? "";
  const dotIdx = fileName.lastIndexOf(".");
  return dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
}

function computeOutputHash(
  patterns: readonly PatternResult[],
  diagnostics: readonly AnalyzerDiagnostic[],
): OutputHash {
  const payload = stableStringify({ patterns, diagnostics });
  return createHash("sha256").update(payload).digest("hex") as OutputHash;
}
