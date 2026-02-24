import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ApiRouteAnalyzer } from "../src/analyzers/ApiRouteAnalyzer.js";
import { DatabaseAnalyzer } from "../src/analyzers/DatabaseAnalyzer.js";
import { AuthAnalyzer } from "../src/analyzers/AuthAnalyzer.js";
import { EnvConfigAnalyzer } from "../src/analyzers/EnvConfigAnalyzer.js";
import type { DiscoveredFile, CacheAccessor, FileHash } from "../src/types/index.js";

let passed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  PASS: ${name}`);
}

function createNoopCache(): CacheAccessor {
  return {
    get: () => undefined,
    set: () => {},
    has: () => false,
    invalidate: () => {},
    invalidateByAnalyzer: () => {},
  };
}

async function createProject(files: Record<string, string>): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-backend-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(tmp, name);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
  return tmp;
}

function fakeFile(relativePath: string, ext: string): DiscoveredFile {
  return {
    relativePath,
    absolutePath: `/fake/${relativePath}`,
    extension: ext,
    hash: "abc123" as FileHash,
    size: 100,
    lastModified: Date.now(),
  };
}

// ===========================================================================
// ApiRouteAnalyzer Tests
// ===========================================================================

async function testApiRouteInterface(): Promise<void> {
  const analyzer = new ApiRouteAnalyzer();
  assert.equal(analyzer.name, "api-routes");
  assert.equal(analyzer.version, "1.0.0");
  assert.ok(analyzer.capabilities.length > 0);
  assert.ok(analyzer.capabilities.includes("express-detection"));
  ok("testApiRouteInterface");
}

async function testApiRouteFileFilter(): Promise<void> {
  const analyzer = new ApiRouteAnalyzer();
  assert.equal(analyzer.fileFilter(fakeFile("src/server.ts", "ts")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/server.js", "js")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/styles.css", "css")), false);
  ok("testApiRouteFileFilter");
}

async function testApiRouteDetection(): Promise<void> {
  const tmp = await createProject({
    "src/server.ts": `
import express from 'express';
const app = express();
app.get('/api/users', (req, res) => { res.json([]); });
app.post('/api/users', (req, res) => { res.json({}); });
`,
  });
  try {
    const analyzer = new ApiRouteAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/server.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect API routes");
    const endpoints = output.patterns.filter(p => p.metadata.method !== undefined);
    assert.ok(endpoints.length >= 2, "should detect at least 2 endpoints");
    ok("testApiRouteDetection");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testApiRouteEmptyProject(): Promise<void> {
  const tmp = await createProject({
    "src/utils.ts": "export function add(a: number, b: number) { return a + b; }",
  });
  try {
    const analyzer = new ApiRouteAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/utils.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.equal(output.patterns.length, 0, "should return 0 patterns for non-API code");
    ok("testApiRouteEmptyProject");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testApiRouteDeterministic(): Promise<void> {
  const tmp = await createProject({
    "src/server.ts": `
import express from 'express';
const app = express();
app.get('/api/items', (req, res) => { res.json([]); });
`,
  });
  try {
    const analyzer = new ApiRouteAnalyzer();
    const files = [fakeFile("src/server.ts", "ts")];
    const o1 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    const o2 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    assert.equal(o1.hash, o2.hash, "hash should be deterministic");
    ok("testApiRouteDeterministic");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ===========================================================================
// DatabaseAnalyzer Tests
// ===========================================================================

async function testDatabaseInterface(): Promise<void> {
  const analyzer = new DatabaseAnalyzer();
  assert.equal(analyzer.name, "database");
  assert.equal(analyzer.version, "1.0.0");
  assert.ok(analyzer.capabilities.includes("prisma-detection"));
  ok("testDatabaseInterface");
}

async function testDatabaseFileFilter(): Promise<void> {
  const analyzer = new DatabaseAnalyzer();
  assert.equal(analyzer.fileFilter(fakeFile("prisma/schema.prisma", "prisma")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/db.ts", "ts")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/styles.css", "css")), false);
  ok("testDatabaseFileFilter");
}

async function testDatabasePrismaDetection(): Promise<void> {
  const tmp = await createProject({
    "prisma/schema.prisma": `
model User {
  id   Int    @id @default(autoincrement())
  name String
  email String @unique
}

model Post {
  id      Int    @id @default(autoincrement())
  title   String
  author  User   @relation(fields: [authorId], references: [id])
  authorId Int
}
`,
  });
  try {
    const analyzer = new DatabaseAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("prisma/schema.prisma", "prisma")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect Prisma models");
    const userModel = output.patterns.find(p => p.name === "model:User");
    assert.ok(userModel, "should detect User model");
    const postModel = output.patterns.find(p => p.name === "model:Post");
    assert.ok(postModel, "should detect Post model");
    ok("testDatabasePrismaDetection");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testDatabaseEmptyProject(): Promise<void> {
  const tmp = await createProject({
    "src/utils.ts": "export const x = 1;",
  });
  try {
    const analyzer = new DatabaseAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/utils.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.equal(output.patterns.length, 0, "should return 0 patterns for non-DB code");
    ok("testDatabaseEmptyProject");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testDatabaseDeterministic(): Promise<void> {
  const tmp = await createProject({
    "prisma/schema.prisma": `
model User {
  id   Int    @id @default(autoincrement())
  name String
}
`,
  });
  try {
    const analyzer = new DatabaseAnalyzer();
    const files = [fakeFile("prisma/schema.prisma", "prisma")];
    const o1 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    const o2 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    assert.equal(o1.hash, o2.hash, "hash should be deterministic");
    ok("testDatabaseDeterministic");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ===========================================================================
// AuthAnalyzer Tests
// ===========================================================================

async function testAuthInterface(): Promise<void> {
  const analyzer = new AuthAnalyzer();
  assert.equal(analyzer.name, "auth");
  assert.equal(analyzer.version, "1.0.0");
  assert.ok(analyzer.capabilities.includes("jwt-detection"));
  assert.ok(analyzer.capabilities.includes("session-detection"));
  ok("testAuthInterface");
}

async function testAuthFileFilter(): Promise<void> {
  const analyzer = new AuthAnalyzer();
  assert.equal(analyzer.fileFilter(fakeFile("src/auth.ts", "ts")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/auth.js", "js")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/styles.css", "css")), false);
  ok("testAuthFileFilter");
}

async function testAuthDetection(): Promise<void> {
  const tmp = await createProject({
    "src/auth.ts": `
import jwt from 'jsonwebtoken';

export function signToken(payload: object) {
  return jwt.sign(payload, 'secret', { expiresIn: '1h' });
}

export function verifyToken(token: string) {
  return jwt.verify(token, 'secret');
}
`,
  });
  try {
    const analyzer = new AuthAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/auth.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect auth patterns");
    const authPattern = output.patterns.find(p => p.metadata.strategies !== undefined);
    assert.ok(authPattern, "should have auth pattern with strategies");
    const strategies = authPattern!.metadata.strategies as string[];
    assert.ok(strategies.includes("jwt"), "should detect JWT strategy");
    ok("testAuthDetection");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testAuthEmptyProject(): Promise<void> {
  const tmp = await createProject({
    "src/utils.ts": "export const x = 1;",
  });
  try {
    const analyzer = new AuthAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/utils.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.equal(output.patterns.length, 0, "should return 0 patterns for non-auth code");
    ok("testAuthEmptyProject");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testAuthDeterministic(): Promise<void> {
  const tmp = await createProject({
    "src/auth.ts": `
import jwt from 'jsonwebtoken';
jwt.sign({}, 'key');
`,
  });
  try {
    const analyzer = new AuthAnalyzer();
    const files = [fakeFile("src/auth.ts", "ts")];
    const o1 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    const o2 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    assert.equal(o1.hash, o2.hash, "hash should be deterministic");
    ok("testAuthDeterministic");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ===========================================================================
// EnvConfigAnalyzer Tests
// ===========================================================================

async function testEnvConfigInterface(): Promise<void> {
  const analyzer = new EnvConfigAnalyzer();
  assert.equal(analyzer.name, "env-config");
  assert.equal(analyzer.version, "1.0.0");
  assert.ok(analyzer.capabilities.includes("env-file-parsing"));
  assert.ok(analyzer.capabilities.includes("secret-detection"));
  ok("testEnvConfigInterface");
}

async function testEnvConfigFileFilter(): Promise<void> {
  const analyzer = new EnvConfigAnalyzer();
  assert.equal(analyzer.fileFilter(fakeFile(".env", "env")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/config.ts", "ts")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/styles.css", "css")), false);
  ok("testEnvConfigFileFilter");
}

async function testEnvConfigDetection(): Promise<void> {
  const tmp = await createProject({
    ".env": `DATABASE_URL=postgresql://localhost/mydb
PORT=3000
NODE_ENV=development
`,
    "src/config.ts": `
const dbUrl = process.env.DATABASE_URL;
const port = process.env.PORT;
`,
  });
  try {
    const analyzer = new EnvConfigAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [
        fakeFile(".env", "env"),
        fakeFile("src/config.ts", "ts"),
      ],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect env config");
    const summary = output.patterns.find(p => p.name === "env-config-summary");
    assert.ok(summary, "should have summary");
    assert.ok(
      (summary!.metadata as Record<string, unknown>).totalVariables as number >= 1,
      "should detect variables"
    );
    ok("testEnvConfigDetection");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testEnvConfigSecretDetection(): Promise<void> {
  const tmp = await createProject({
    ".env": `SECRET_KEY=mysupersecretkey
API_KEY=abc123def456
DATABASE_PASSWORD=hunter2
PLAIN_VALUE=hello
`,
  });
  try {
    const analyzer = new EnvConfigAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile(".env", "env")],
      cache: createNoopCache(),
    });
    const summary = output.patterns.find(p => p.name === "env-config-summary");
    assert.ok(summary, "should have summary");
    assert.ok(
      (summary!.metadata as Record<string, unknown>).secretCount as number >= 2,
      "should detect secrets (SECRET_KEY, API_KEY, DATABASE_PASSWORD)"
    );
    ok("testEnvConfigSecretDetection");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testEnvConfigDeterministic(): Promise<void> {
  const tmp = await createProject({
    ".env": "DB_HOST=localhost\nDB_PORT=5432\n",
  });
  try {
    const analyzer = new EnvConfigAnalyzer();
    const files = [fakeFile(".env", "env")];
    const o1 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    const o2 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    assert.equal(o1.hash, o2.hash, "hash should be deterministic");
    ok("testEnvConfigDeterministic");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
  console.log("BackendAnalyzers Tests");

  console.log("\n  --- ApiRouteAnalyzer ---");
  await testApiRouteInterface();
  await testApiRouteFileFilter();
  await testApiRouteDetection();
  await testApiRouteEmptyProject();
  await testApiRouteDeterministic();

  console.log("\n  --- DatabaseAnalyzer ---");
  await testDatabaseInterface();
  await testDatabaseFileFilter();
  await testDatabasePrismaDetection();
  await testDatabaseEmptyProject();
  await testDatabaseDeterministic();

  console.log("\n  --- AuthAnalyzer ---");
  await testAuthInterface();
  await testAuthFileFilter();
  await testAuthDetection();
  await testAuthEmptyProject();
  await testAuthDeterministic();

  console.log("\n  --- EnvConfigAnalyzer ---");
  await testEnvConfigInterface();
  await testEnvConfigFileFilter();
  await testEnvConfigDetection();
  await testEnvConfigSecretDetection();
  await testEnvConfigDeterministic();

  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
