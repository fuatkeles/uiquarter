import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NuxtAnalyzer } from "../src/analyzers/NuxtAnalyzer.js";
import { FileDiscovery } from "../src/core/FileDiscovery.js";
import type {
  DiscoveredFile,
  FileHash,
  CacheAccessor,
} from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function pass(name: string): void {
  console.log(`  PASS: ${name}`);
  passed++;
}

const ROOT = join(tmpdir(), "uiq-nuxt-test-" + Date.now());

async function freshProject(files: Record<string, string>): Promise<string> {
  const dir = join(
    ROOT,
    String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6),
  );
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf-8");
  }
  return dir;
}

function fakeFile(relativePath: string, ext: string): DiscoveredFile {
  return {
    absolutePath: `/fake/${relativePath}`,
    relativePath,
    hash: "fakehash" as FileHash,
    size: 100,
    extension: ext,
    lastModified: Date.now(),
  };
}

const noopAccessor: CacheAccessor = {
  get: () => undefined,
  set: () => {},
  has: () => false,
  invalidate: () => {},
  invalidateByAnalyzer: () => {},
};

// ---------------------------------------------------------------------------
// Interface tests
// ---------------------------------------------------------------------------

function testNuxtAnalyzerInterface() {
  const analyzer = new NuxtAnalyzer();

  assert(analyzer.name === "nuxt", `name should be "nuxt", got "${analyzer.name}"`);
  assert(analyzer.version === "1.0.0", `version should be "1.0.0"`);
  assert(analyzer.capabilities.includes("nuxt-page-detection"), "should have nuxt-page-detection");
  assert(analyzer.capabilities.includes("nuxt-composable-detection"), "should have nuxt-composable-detection");
  assert(analyzer.capabilities.includes("nuxt-server-route-detection"), "should have nuxt-server-route-detection");
  assert(analyzer.dependencies !== undefined && analyzer.dependencies.includes("component"), "should depend on component");

  pass("testNuxtAnalyzerInterface");
}

function testNuxtAnalyzerFileFilter() {
  const analyzer = new NuxtAnalyzer();

  assert(analyzer.fileFilter(fakeFile("pages/index.vue", "vue")), ".vue should be accepted");
  assert(analyzer.fileFilter(fakeFile("composables/useAuth.ts", "ts")), ".ts should be accepted");
  assert(analyzer.fileFilter(fakeFile("server/api/users.ts", "ts")), ".ts should be accepted");

  assert(!analyzer.fileFilter(fakeFile("assets/style.css", "css")), ".css should be rejected");
  assert(!analyzer.fileFilter(fakeFile("public/favicon.png", "png")), ".png should be rejected");

  pass("testNuxtAnalyzerFileFilter");
}

// ---------------------------------------------------------------------------
// Non-Nuxt project
// ---------------------------------------------------------------------------

async function testNonNuxtProjectReturnsEmpty() {
  const root = await freshProject({
    "src/App.vue": `<template><div>Hello</div></template>`,
    "src/main.ts": `import { createApp } from "vue"; createApp(App).mount("#app");`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NuxtAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  assert(output.patterns.length === 0, `Non-Nuxt should have 0 patterns, got ${output.patterns.length}`);

  await rm(root, { recursive: true, force: true });
  pass("testNonNuxtProjectReturnsEmpty");
}

// ---------------------------------------------------------------------------
// Page detection
// ---------------------------------------------------------------------------

async function testPageDetection() {
  const root = await freshProject({
    "nuxt.config.ts": `export default defineNuxtConfig({});`,
    "pages/index.vue": `<template><div>Home</div></template>`,
    "pages/about.vue": `<template><div>About</div></template>`,
    "pages/blog/[slug].vue": `<template><div>Post</div></template>\n<script setup>\ndefinePageMeta({ layout: 'blog' });\n</script>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NuxtAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const summary = output.patterns.find((p) => p.name === "nuxt-framework");
  assert(summary !== undefined, "Should have nuxt-framework summary pattern");
  assert((summary!.metadata["pageCount"] as number) === 3, `Should detect 3 pages, got ${summary!.metadata["pageCount"]}`);

  const homePage = output.patterns.find((p) => p.name === "Page:/");
  assert(homePage !== undefined, "Should detect home page");
  assert(homePage!.type === "page", "Home type should be page");

  const aboutPage = output.patterns.find((p) => p.name === "Page:/about");
  assert(aboutPage !== undefined, "Should detect about page");

  const blogPost = output.patterns.find((p) => p.filePath.includes("[slug]"));
  assert(blogPost !== undefined, "Should detect dynamic blog page");
  assert(blogPost!.metadata["routePath"] === "/blog/:slug", `Route should be "/blog/:slug", got "${String(blogPost!.metadata["routePath"])}"`);
  assert(blogPost!.metadata["hasDefinePageMeta"] === true, "Should detect definePageMeta");

  await rm(root, { recursive: true, force: true });
  pass("testPageDetection");
}

// ---------------------------------------------------------------------------
// Layout detection
// ---------------------------------------------------------------------------

async function testLayoutDetection() {
  const root = await freshProject({
    "nuxt.config.ts": `export default defineNuxtConfig({});`,
    "layouts/default.vue": `<template><div><slot/></div></template>`,
    "layouts/blog.vue": `<template><div class="blog"><slot/></div></template>`,
    "pages/index.vue": `<template><div>Home</div></template>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NuxtAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const summary = output.patterns.find((p) => p.name === "nuxt-framework");
  assert((summary!.metadata["layoutCount"] as number) === 2, "Should detect 2 layouts");

  const defaultLayout = output.patterns.find((p) => p.name === "Layout:default");
  assert(defaultLayout !== undefined, "Should detect default layout");
  assert(defaultLayout!.type === "layout", "Layout type should be layout");

  const blogLayout = output.patterns.find((p) => p.name === "Layout:blog");
  assert(blogLayout !== undefined, "Should detect blog layout");

  await rm(root, { recursive: true, force: true });
  pass("testLayoutDetection");
}

// ---------------------------------------------------------------------------
// Composable detection
// ---------------------------------------------------------------------------

async function testComposableDetection() {
  const root = await freshProject({
    "nuxt.config.ts": `export default defineNuxtConfig({});`,
    "composables/useAuth.ts": `export function useAuth() { return { user: null }; }`,
    "composables/useCart.ts": `export function useCart() { return { items: [] }; }`,
    "composables/helpers.ts": `export function formatPrice(n: number) { return "$" + n; }`,
    "pages/index.vue": `<template><div>Home</div></template>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NuxtAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const summary = output.patterns.find((p) => p.name === "nuxt-framework");
  assert((summary!.metadata["composableCount"] as number) === 3, "Should detect 3 composables");

  const useAuth = output.patterns.find((p) => p.name === "useAuth");
  assert(useAuth !== undefined, "Should detect useAuth");
  assert(useAuth!.type === "composable", "useAuth type should be composable");

  // helpers.ts should trigger naming convention diagnostic
  const namingDiag = output.diagnostics.find((d) => d.message.includes("helpers") && d.message.includes("use"));
  assert(namingDiag !== undefined, "Should warn about composable not starting with 'use'");

  await rm(root, { recursive: true, force: true });
  pass("testComposableDetection");
}

// ---------------------------------------------------------------------------
// Server routes detection
// ---------------------------------------------------------------------------

async function testServerRouteDetection() {
  const root = await freshProject({
    "nuxt.config.ts": `export default defineNuxtConfig({});`,
    "server/api/users.ts": `export default defineEventHandler(() => [{ name: "John" }]);`,
    "server/api/users/[id].ts": `export default defineEventHandler(() => ({ name: "John" }));`,
    "server/routes/health.ts": `export default defineEventHandler(() => ({ ok: true }));`,
    "pages/index.vue": `<template><div>Home</div></template>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NuxtAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const summary = output.patterns.find((p) => p.name === "nuxt-framework");
  assert((summary!.metadata["serverRouteCount"] as number) === 3, `Should detect 3 server routes, got ${summary!.metadata["serverRouteCount"]}`);

  const usersRoute = output.patterns.find((p) => p.name === "ServerRoute:/api/users");
  assert(usersRoute !== undefined, "Should detect /api/users route");
  assert(usersRoute!.type === "utility", "Server route type should be utility");

  const userByIdRoute = output.patterns.find((p) => p.filePath.includes("[id]"));
  assert(userByIdRoute !== undefined, "Should detect /api/users/:id route");

  const healthRoute = output.patterns.find((p) => p.name === "ServerRoute:/health");
  assert(healthRoute !== undefined, "Should detect /health route");

  await rm(root, { recursive: true, force: true });
  pass("testServerRouteDetection");
}

// ---------------------------------------------------------------------------
// Middleware and plugins
// ---------------------------------------------------------------------------

async function testMiddlewareAndPlugins() {
  const root = await freshProject({
    "nuxt.config.ts": `export default defineNuxtConfig({});`,
    "middleware/auth.ts": `export default defineNuxtRouteMiddleware((to, from) => { /* auth check */ });`,
    "plugins/analytics.ts": `export default defineNuxtPlugin(() => { /* track */ });`,
    "pages/index.vue": `<template><div>Home</div></template>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NuxtAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const summary = output.patterns.find((p) => p.name === "nuxt-framework");
  assert((summary!.metadata["middlewareCount"] as number) === 1, "Should detect 1 middleware");
  assert((summary!.metadata["pluginCount"] as number) === 1, "Should detect 1 plugin");

  const middleware = output.patterns.find((p) => p.name === "Middleware:auth");
  assert(middleware !== undefined, "Should detect auth middleware");
  assert(middleware!.metadata["hasDefineNuxtMiddleware"] === true, "Should detect defineNuxtRouteMiddleware");

  const plugin = output.patterns.find((p) => p.name === "Plugin:analytics");
  assert(plugin !== undefined, "Should detect analytics plugin");
  assert(plugin!.metadata["hasDefineNuxtPlugin"] === true, "Should detect defineNuxtPlugin");

  await rm(root, { recursive: true, force: true });
  pass("testMiddlewareAndPlugins");
}

// ---------------------------------------------------------------------------
// Deterministic hash
// ---------------------------------------------------------------------------

async function testDeterministicHash() {
  const root = await freshProject({
    "nuxt.config.ts": `export default defineNuxtConfig({});`,
    "pages/index.vue": `<template><div>Home</div></template>`,
    "composables/useAuth.ts": `export function useAuth() { return {}; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NuxtAnalyzer();
  const filtered = files.filter((f) => analyzer.fileFilter(f));

  const ctx = {
    rootPath: root,
    files: filtered,
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  };

  const output1 = await analyzer.analyze(ctx);
  const output2 = await analyzer.analyze(ctx);

  assert(output1.hash === output2.hash, `Hashes should match`);
  assert(output1.patterns.length === output2.patterns.length, "Pattern counts should match");

  await rm(root, { recursive: true, force: true });
  pass("testDeterministicHash");
}

// ---------------------------------------------------------------------------
// app.vue and error.vue
// ---------------------------------------------------------------------------

async function testAppAndErrorVue() {
  const root = await freshProject({
    "nuxt.config.ts": `export default defineNuxtConfig({});`,
    "app.vue": `<template><NuxtPage/></template>`,
    "error.vue": `<template><div>Error occurred</div></template>`,
    "pages/index.vue": `<template><div>Home</div></template>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NuxtAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const appVue = output.patterns.find((p) => p.name === "App");
  assert(appVue !== undefined, "Should detect app.vue");
  assert(appVue!.metadata["nuxtRole"] === "app-vue", "Should have app-vue role");

  const errorVue = output.patterns.find((p) => p.name === "ErrorPage");
  assert(errorVue !== undefined, "Should detect error.vue");
  assert(errorVue!.metadata["nuxtRole"] === "error-vue", "Should have error-vue role");

  await rm(root, { recursive: true, force: true });
  pass("testAppAndErrorVue");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Nuxt Analyzer tests\n");

  testNuxtAnalyzerInterface();
  testNuxtAnalyzerFileFilter();

  await testNonNuxtProjectReturnsEmpty();
  await testPageDetection();
  await testLayoutDetection();
  await testComposableDetection();
  await testServerRouteDetection();
  await testMiddlewareAndPlugins();
  await testDeterministicHash();
  await testAppAndErrorVue();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

  try {
    await rm(ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
