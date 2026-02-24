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

const DB_EXTENSIONS = new Set(["ts", "js", "prisma"]);

/** Prisma schema patterns */
const PRISMA_MODEL_RE = /^model\s+(\w+)\s*\{/gm;
const PRISMA_RELATION_RE = /@relation\s*\(/g;
const PRISMA_ID_RE = /@id\b/g;
const PRISMA_UNIQUE_RE = /@unique\b/g;

/** TypeORM decorators */
const TYPEORM_ENTITY_RE = /@Entity\s*\(/g;
const TYPEORM_COLUMN_RE = /@Column\s*\(/g;
const TYPEORM_MANY_TO_ONE_RE = /@ManyToOne\s*\(/g;
const TYPEORM_ONE_TO_MANY_RE = /@OneToMany\s*\(/g;
const TYPEORM_MANY_TO_MANY_RE = /@ManyToMany\s*\(/g;
const TYPEORM_ONE_TO_ONE_RE = /@OneToOne\s*\(/g;
const TYPEORM_PRIMARY_RE = /@PrimaryGeneratedColumn\s*\(/g;
const TYPEORM_IMPORT_RE = /from\s+['"]typeorm['"]/;

/** Drizzle patterns */
const DRIZZLE_PG_RE = /pgTable\s*\(\s*['"](\w+)['"]/g;
const DRIZZLE_MYSQL_RE = /mysqlTable\s*\(\s*['"](\w+)['"]/g;
const DRIZZLE_SQLITE_RE = /sqliteTable\s*\(\s*['"](\w+)['"]/g;
const DRIZZLE_IMPORT_RE = /from\s+['"]drizzle-orm/;

/** Sequelize patterns */
const SEQUELIZE_INIT_RE = /Model\.init\s*\(/g;
const SEQUELIZE_DEFINE_RE = /sequelize\.define\s*\(\s*['"](\w+)['"]/g;
const SEQUELIZE_IMPORT_RE = /from\s+['"]sequelize['"]/;

/** Mongoose patterns */
const MONGOOSE_SCHEMA_RE = /new\s+Schema\s*\(/g;
const MONGOOSE_MODEL_RE = /mongoose\.model\s*\(\s*['"](\w+)['"]/g;
const MONGOOSE_IMPORT_RE = /from\s+['"]mongoose['"]/;

/** Migration directory detection */
const MIGRATION_DIR_RE = /(?:^|\/)(?:migration|migrate)s?\//i;

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

type OrmType = "prisma" | "typeorm" | "drizzle" | "sequelize" | "mongoose" | "unknown";

interface DbFileMetrics {
  readonly filePath: string;
  readonly orm: OrmType;
  readonly modelNames: readonly string[];
  readonly modelCount: number;
  readonly relationCount: number;
  readonly columnCount: number;
  readonly isMigration: boolean;
  readonly idCount: number;
  readonly uniqueCount: number;
}

// -----------------------------------------------------------------------------
// DatabaseAnalyzer
// -----------------------------------------------------------------------------

export class DatabaseAnalyzer implements Analyzer {
  readonly name = "database";
  readonly version = "1.0.0";
  readonly capabilities = [
    "prisma-detection",
    "typeorm-detection",
    "drizzle-detection",
    "sequelize-detection",
    "mongoose-detection",
    "migration-detection",
  ] as const;
  readonly dependencies = [] as const;

  fileFilter(file: DiscoveredFile): boolean {
    return DB_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [];
    const allMetrics: DbFileMetrics[] = [];
    let cacheHits = 0;

    for (const file of context.files) {
      if (context.signal?.aborted) break;

      const cacheKey = `database:${file.relativePath}:${file.hash as string}` as CacheKey;
      const cached = context.cache.get<DbFileMetrics>(cacheKey);
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

      const metrics = analyzeDbFile(file, content);
      allMetrics.push(metrics);
      context.cache.set(cacheKey, metrics, file.hash as FileHash);
    }

    // Only produce patterns if database usage detected
    const detectedFiles = allMetrics.filter((m) => m.orm !== "unknown");
    if (detectedFiles.length === 0) {
      const duration = Date.now() - start;
      const hash = computeOutputHash([], []);
      return {
        analyzerId: `${this.name}@${this.version}` as AnalyzerId,
        patterns: [],
        diagnostics: [],
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

    // Aggregate
    let totalModels = 0;
    let totalRelations = 0;
    let totalMigrations = 0;
    const ormTypes = new Set<string>();

    for (const m of detectedFiles) {
      ormTypes.add(m.orm);
      totalModels += m.modelCount;
      totalRelations += m.relationCount;
      if (m.isMigration) totalMigrations++;

      // Per-file model patterns
      for (const modelName of m.modelNames) {
        const pid = `${m.filePath}:model:${modelName}` as PatternId;
        patterns.push({
          id: pid,
          type: "utility" as PatternType,
          name: `model:${modelName}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.9,
            source: "schema-detection",
            factors: [{ name: "model-definition", weight: 1, score: 0.9 }],
          },
          framework: m.orm,
          dependencies: [],
          properties: {},
          metadata: {
            orm: m.orm,
            modelName,
          },
        });
      }

      // Schema file pattern (if has models but no individual names)
      if (m.modelCount > 0 && m.modelNames.length === 0) {
        const pid = `${m.filePath}:schema:1` as PatternId;
        patterns.push({
          id: pid,
          type: "utility" as PatternType,
          name: `schema:${extractFileName(m.filePath)}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.85,
            source: "schema-detection",
            factors: [{ name: "orm-entity", weight: 1, score: 0.85 }],
          },
          framework: m.orm,
          dependencies: [],
          properties: {},
          metadata: {
            orm: m.orm,
            modelCount: m.modelCount,
            relationCount: m.relationCount,
            columnCount: m.columnCount,
          },
        });
      }

      // Migration pattern
      if (m.isMigration) {
        const pid = `${m.filePath}:migration:1` as PatternId;
        patterns.push({
          id: pid,
          type: "utility" as PatternType,
          name: `migration:${extractFileName(m.filePath)}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.85,
            source: "path-detection",
            factors: [{ name: "migration-directory", weight: 1, score: 0.85 }],
          },
          framework: m.orm,
          dependencies: [],
          properties: {},
          metadata: { isMigration: true },
        });
      }
    }

    // Summary pattern
    const summaryId = `.:database-summary:1` as PatternId;
    patterns.push({
      id: summaryId,
      type: "utility" as PatternType,
      name: "database-summary",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: 0.9,
        source: "database-analysis",
        factors: [{ name: "orm-detection", weight: 1, score: 0.9 }],
      },
      framework: "generic",
      dependencies: [],
      properties: {},
      metadata: {
        ormTypes: [...ormTypes].sort(),
        totalModels,
        totalRelations,
        totalMigrations,
        totalSchemaFiles: detectedFiles.filter((m) => m.modelCount > 0).length,
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

function analyzeDbFile(file: DiscoveredFile, content: string): DbFileMetrics {
  const isMigration = MIGRATION_DIR_RE.test(file.relativePath);

  // Detect ORM
  let orm: OrmType = "unknown";
  if (file.extension === "prisma") {
    orm = "prisma";
  } else if (TYPEORM_IMPORT_RE.test(content)) {
    orm = "typeorm";
  } else if (DRIZZLE_IMPORT_RE.test(content)) {
    orm = "drizzle";
  } else if (SEQUELIZE_IMPORT_RE.test(content)) {
    orm = "sequelize";
  } else if (MONGOOSE_IMPORT_RE.test(content)) {
    orm = "mongoose";
  }

  if (orm === "unknown" && !isMigration) {
    return {
      filePath: file.relativePath,
      orm,
      modelNames: [],
      modelCount: 0,
      relationCount: 0,
      columnCount: 0,
      isMigration: false,
      idCount: 0,
      uniqueCount: 0,
    };
  }

  const modelNames: string[] = [];
  let modelCount = 0;
  let relationCount = 0;
  let columnCount = 0;
  let idCount = 0;
  let uniqueCount = 0;
  let match: RegExpExecArray | null;

  if (orm === "prisma") {
    const modelRe = new RegExp(PRISMA_MODEL_RE.source, PRISMA_MODEL_RE.flags);
    while ((match = modelRe.exec(content)) !== null) {
      modelNames.push(match[1]!);
      modelCount++;
    }
    const relRe = new RegExp(PRISMA_RELATION_RE.source, PRISMA_RELATION_RE.flags);
    while (relRe.exec(content) !== null) relationCount++;
    const idRe = new RegExp(PRISMA_ID_RE.source, PRISMA_ID_RE.flags);
    while (idRe.exec(content) !== null) idCount++;
    const uniqRe = new RegExp(PRISMA_UNIQUE_RE.source, PRISMA_UNIQUE_RE.flags);
    while (uniqRe.exec(content) !== null) uniqueCount++;
  }

  if (orm === "typeorm") {
    const entityRe = new RegExp(TYPEORM_ENTITY_RE.source, TYPEORM_ENTITY_RE.flags);
    while (entityRe.exec(content) !== null) modelCount++;
    const colRe = new RegExp(TYPEORM_COLUMN_RE.source, TYPEORM_COLUMN_RE.flags);
    while (colRe.exec(content) !== null) columnCount++;
    const m2oRe = new RegExp(TYPEORM_MANY_TO_ONE_RE.source, TYPEORM_MANY_TO_ONE_RE.flags);
    while (m2oRe.exec(content) !== null) relationCount++;
    const o2mRe = new RegExp(TYPEORM_ONE_TO_MANY_RE.source, TYPEORM_ONE_TO_MANY_RE.flags);
    while (o2mRe.exec(content) !== null) relationCount++;
    const m2mRe = new RegExp(TYPEORM_MANY_TO_MANY_RE.source, TYPEORM_MANY_TO_MANY_RE.flags);
    while (m2mRe.exec(content) !== null) relationCount++;
    const o2oRe = new RegExp(TYPEORM_ONE_TO_ONE_RE.source, TYPEORM_ONE_TO_ONE_RE.flags);
    while (o2oRe.exec(content) !== null) relationCount++;
    const pkRe = new RegExp(TYPEORM_PRIMARY_RE.source, TYPEORM_PRIMARY_RE.flags);
    while (pkRe.exec(content) !== null) idCount++;
  }

  if (orm === "drizzle") {
    for (const re of [DRIZZLE_PG_RE, DRIZZLE_MYSQL_RE, DRIZZLE_SQLITE_RE]) {
      const drRe = new RegExp(re.source, re.flags);
      while ((match = drRe.exec(content)) !== null) {
        modelNames.push(match[1]!);
        modelCount++;
      }
    }
  }

  if (orm === "sequelize") {
    const initRe = new RegExp(SEQUELIZE_INIT_RE.source, SEQUELIZE_INIT_RE.flags);
    while (initRe.exec(content) !== null) modelCount++;
    const defRe = new RegExp(SEQUELIZE_DEFINE_RE.source, SEQUELIZE_DEFINE_RE.flags);
    while ((match = defRe.exec(content)) !== null) {
      modelNames.push(match[1]!);
      modelCount++;
    }
  }

  if (orm === "mongoose") {
    const schemaRe = new RegExp(MONGOOSE_SCHEMA_RE.source, MONGOOSE_SCHEMA_RE.flags);
    while (schemaRe.exec(content) !== null) modelCount++;
    const mdlRe = new RegExp(MONGOOSE_MODEL_RE.source, MONGOOSE_MODEL_RE.flags);
    while ((match = mdlRe.exec(content)) !== null) {
      modelNames.push(match[1]!);
    }
  }

  return {
    filePath: file.relativePath,
    orm,
    modelNames,
    modelCount,
    relationCount,
    columnCount,
    isMigration,
    idCount,
    uniqueCount,
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
