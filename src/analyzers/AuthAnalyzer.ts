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

const AUTH_EXTENSIONS = new Set(["ts", "js"]);

/** JWT patterns */
const JWT_SIGN_RE = /jwt\.sign\s*\(/g;
const JWT_VERIFY_RE = /jwt\.verify\s*\(/g;
const JWT_IMPORT_RE = /(?:from\s+['"]jsonwebtoken['"]|require\s*\(\s*['"]jsonwebtoken['"]\s*\))/;

/** Session patterns */
const EXPRESS_SESSION_RE = /(?:from\s+['"]express-session['"]|require\s*\(\s*['"]express-session['"]\s*\))/;
const COOKIE_SESSION_RE = /(?:from\s+['"]cookie-session['"]|require\s*\(\s*['"]cookie-session['"]\s*\))/;

/** OAuth / third-party auth */
const PASSPORT_RE = /(?:from\s+['"]passport['"]|require\s*\(\s*['"]passport['"]\s*\))/;
const NEXT_AUTH_RE = /from\s+['"]next-auth['"]/;
const AUTH_CORE_RE = /from\s+['"]@auth\/core['"]/;
const AUTH0_RE = /(?:from\s+['"]auth0['"]|from\s+['"]@auth0\/)/;
const CLERK_RE = /from\s+['"]@clerk\//;

/** Auth middleware patterns */
const REQ_USER_RE = /\breq\.user\b/g;
const REQ_SESSION_RE = /\breq\.session\b/g;
const IS_AUTHENTICATED_RE = /\bisAuthenticated\b/g;

/** Guards (NestJS / Angular) */
const USE_GUARDS_RE = /@UseGuards\s*\(/g;
const CAN_ACTIVATE_RE = /\bcanActivate\b/g;

/** RBAC patterns */
const HAS_ROLE_RE = /\bhasRole\s*\(/g;
const CHECK_PERMISSION_RE = /\bcheckPermission\s*\(/g;
const AUTHORIZE_RE = /\bauthorize\s*\(/g;

/** Token extraction */
const BEARER_TOKEN_RE = /[Bb]earer\s/g;
const AUTH_HEADER_RE = /(?:authorization|x-auth-token|x-access-token)\b/gi;

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

type AuthStrategy =
  | "jwt"
  | "session"
  | "passport"
  | "next-auth"
  | "auth-core"
  | "auth0"
  | "clerk";

interface AuthFileMetrics {
  readonly filePath: string;
  readonly strategies: readonly AuthStrategy[];
  readonly jwtSignCount: number;
  readonly jwtVerifyCount: number;
  readonly middlewareSignals: number;
  readonly guardCount: number;
  readonly rbacCount: number;
  readonly hasReqUser: boolean;
  readonly hasReqSession: boolean;
  readonly hasIsAuthenticated: boolean;
  readonly hasAuthHeader: boolean;
  readonly isAuthRelated: boolean;
}

// -----------------------------------------------------------------------------
// AuthAnalyzer
// -----------------------------------------------------------------------------

export class AuthAnalyzer implements Analyzer {
  readonly name = "auth";
  readonly version = "1.0.0";
  readonly capabilities = [
    "jwt-detection",
    "session-detection",
    "oauth-detection",
    "guard-detection",
    "rbac-detection",
    "middleware-detection",
  ] as const;
  readonly dependencies = [] as const;

  fileFilter(file: DiscoveredFile): boolean {
    return AUTH_EXTENSIONS.has(file.extension);
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    const patterns: PatternResult[] = [];
    const diagnostics: AnalyzerDiagnostic[] = [];
    const allMetrics: AuthFileMetrics[] = [];
    let cacheHits = 0;

    for (const file of context.files) {
      if (context.signal?.aborted) break;

      const cacheKey = `auth:${file.relativePath}:${file.hash as string}` as CacheKey;
      const cached = context.cache.get<AuthFileMetrics>(cacheKey);
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

      const metrics = analyzeAuthFile(file, content);
      allMetrics.push(metrics);
      context.cache.set(cacheKey, metrics, file.hash as FileHash);
    }

    // Only produce patterns if auth-related imports detected
    const authFiles = allMetrics.filter((m) => m.isAuthRelated);
    if (authFiles.length === 0) {
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
    const allStrategies = new Set<string>();
    let totalMiddleware = 0;
    let totalGuards = 0;
    let totalRbac = 0;
    let totalJwtOps = 0;

    for (const m of authFiles) {
      for (const s of m.strategies) allStrategies.add(s);
      totalMiddleware += m.middlewareSignals;
      totalGuards += m.guardCount;
      totalRbac += m.rbacCount;
      totalJwtOps += m.jwtSignCount + m.jwtVerifyCount;

      // Per-file auth pattern
      const pid = `${m.filePath}:auth:1` as PatternId;
      patterns.push({
        id: pid,
        type: "utility" as PatternType,
        name: `auth:${extractFileName(m.filePath)}`,
        filePath: m.filePath,
        location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
        confidence: {
          value: 0.9,
          source: "auth-detection",
          factors: [{ name: "auth-import", weight: 1, score: 0.9 }],
        },
        framework: "generic",
        dependencies: [],
        properties: {},
        metadata: {
          strategies: [...m.strategies].sort(),
          jwtSignCount: m.jwtSignCount,
          jwtVerifyCount: m.jwtVerifyCount,
          guardCount: m.guardCount,
          rbacCount: m.rbacCount,
          hasReqUser: m.hasReqUser,
          hasReqSession: m.hasReqSession,
        },
      });

      // Guard patterns
      if (m.guardCount > 0) {
        const gid = `${m.filePath}:guard:1` as PatternId;
        patterns.push({
          id: gid,
          type: "utility" as PatternType,
          name: `guard:${extractFileName(m.filePath)}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.85,
            source: "guard-detection",
            factors: [{ name: "guard-pattern", weight: 1, score: 0.85 }],
          },
          framework: "generic",
          dependencies: [],
          properties: {},
          metadata: { guardCount: m.guardCount },
        });
      }

      // RBAC patterns
      if (m.rbacCount > 0) {
        const rid = `${m.filePath}:rbac:1` as PatternId;
        patterns.push({
          id: rid,
          type: "utility" as PatternType,
          name: `rbac:${extractFileName(m.filePath)}`,
          filePath: m.filePath,
          location: { file: m.filePath, start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          confidence: {
            value: 0.85,
            source: "rbac-detection",
            factors: [{ name: "rbac-pattern", weight: 1, score: 0.85 }],
          },
          framework: "generic",
          dependencies: [],
          properties: {},
          metadata: { rbacCount: m.rbacCount },
        });
      }
    }

    // Summary pattern
    const summaryId = `.:auth-summary:1` as PatternId;
    patterns.push({
      id: summaryId,
      type: "utility" as PatternType,
      name: "auth-summary",
      filePath: ".",
      location: { file: ".", start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      confidence: {
        value: 0.9,
        source: "auth-analysis",
        factors: [{ name: "auth-detection", weight: 1, score: 0.9 }],
      },
      framework: "generic",
      dependencies: [],
      properties: {},
      metadata: {
        strategies: [...allStrategies].sort(),
        totalAuthFiles: authFiles.length,
        totalMiddleware,
        totalGuards,
        totalRbac,
        totalJwtOps,
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

function analyzeAuthFile(file: DiscoveredFile, content: string): AuthFileMetrics {
  const strategies: AuthStrategy[] = [];

  // Detect strategies via imports
  if (JWT_IMPORT_RE.test(content)) strategies.push("jwt");
  if (EXPRESS_SESSION_RE.test(content) || COOKIE_SESSION_RE.test(content)) strategies.push("session");
  if (PASSPORT_RE.test(content)) strategies.push("passport");
  if (NEXT_AUTH_RE.test(content)) strategies.push("next-auth");
  if (AUTH_CORE_RE.test(content)) strategies.push("auth-core");
  if (AUTH0_RE.test(content)) strategies.push("auth0");
  if (CLERK_RE.test(content)) strategies.push("clerk");

  // JWT operations
  const jwtSignRe = new RegExp(JWT_SIGN_RE.source, JWT_SIGN_RE.flags);
  let jwtSignCount = 0;
  while (jwtSignRe.exec(content) !== null) jwtSignCount++;

  const jwtVerifyRe = new RegExp(JWT_VERIFY_RE.source, JWT_VERIFY_RE.flags);
  let jwtVerifyCount = 0;
  while (jwtVerifyRe.exec(content) !== null) jwtVerifyCount++;

  // Middleware signals
  const reqUserRe = new RegExp(REQ_USER_RE.source, REQ_USER_RE.flags);
  let reqUserCount = 0;
  while (reqUserRe.exec(content) !== null) reqUserCount++;
  const hasReqUser = reqUserCount > 0;

  const reqSessionRe = new RegExp(REQ_SESSION_RE.source, REQ_SESSION_RE.flags);
  let reqSessionCount = 0;
  while (reqSessionRe.exec(content) !== null) reqSessionCount++;
  const hasReqSession = reqSessionCount > 0;

  const isAuthRe = new RegExp(IS_AUTHENTICATED_RE.source, IS_AUTHENTICATED_RE.flags);
  let isAuthCount = 0;
  while (isAuthRe.exec(content) !== null) isAuthCount++;
  const hasIsAuthenticated = isAuthCount > 0;

  const authHeaderRe = new RegExp(AUTH_HEADER_RE.source, AUTH_HEADER_RE.flags);
  let authHeaderCount = 0;
  while (authHeaderRe.exec(content) !== null) authHeaderCount++;
  const hasAuthHeader = authHeaderCount > 0;

  const bearerRe = new RegExp(BEARER_TOKEN_RE.source, BEARER_TOKEN_RE.flags);
  let bearerCount = 0;
  while (bearerRe.exec(content) !== null) bearerCount++;

  const middlewareSignals = reqUserCount + reqSessionCount + isAuthCount + bearerCount;

  // Guards
  const useGuardsRe = new RegExp(USE_GUARDS_RE.source, USE_GUARDS_RE.flags);
  let guardCount = 0;
  while (useGuardsRe.exec(content) !== null) guardCount++;

  const canActivateRe = new RegExp(CAN_ACTIVATE_RE.source, CAN_ACTIVATE_RE.flags);
  while (canActivateRe.exec(content) !== null) guardCount++;

  // RBAC
  const hasRoleRe = new RegExp(HAS_ROLE_RE.source, HAS_ROLE_RE.flags);
  let rbacCount = 0;
  while (hasRoleRe.exec(content) !== null) rbacCount++;

  const checkPermRe = new RegExp(CHECK_PERMISSION_RE.source, CHECK_PERMISSION_RE.flags);
  while (checkPermRe.exec(content) !== null) rbacCount++;

  const authorizeRe = new RegExp(AUTHORIZE_RE.source, AUTHORIZE_RE.flags);
  while (authorizeRe.exec(content) !== null) rbacCount++;

  const isAuthRelated =
    strategies.length > 0 ||
    jwtSignCount > 0 ||
    jwtVerifyCount > 0 ||
    guardCount > 0 ||
    rbacCount > 0 ||
    (middlewareSignals > 0 && hasAuthHeader);

  return {
    filePath: file.relativePath,
    strategies,
    jwtSignCount,
    jwtVerifyCount,
    middlewareSignals,
    guardCount,
    rbacCount,
    hasReqUser,
    hasReqSession,
    hasIsAuthenticated,
    hasAuthHeader,
    isAuthRelated,
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
