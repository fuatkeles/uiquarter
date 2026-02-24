import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SvelteKitAnalyzer } from "../src/analyzers/SvelteKitAnalyzer.js";
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

const ROOT = join(tmpdir(), "uiq-sveltekit-test-" + Date.now());

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

function testInterface() {
  const analyzer = new SvelteKitAnalyzer();

  assert(analyzer.name === "sveltekit", `name should be "sveltekit"`);
  assert(analyzer.version === "1.0.0", `version should be "1.0.0"`);
  assert(analyzer.capabilities.includes("sveltekit-route-detection"), "should have sveltekit-route-detection");
  assert(analyzer.capabilities.includes("sveltekit-rune-detection"), "should have sveltekit-rune-detection");
  assert(analyzer.capabilities.includes("sveltekit-load-function-detection"), "should have sveltekit-load-function-detection");

  pass("testInterface");
}

function testFileFilter() {
  const analyzer = new SvelteKitAnalyzer();

  assert(analyzer.fileFilter(fakeFile("src/routes/+page.svelte", "svelte")), ".svelte should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/routes/+page.ts", "ts")), ".ts should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/routes/+server.js", "js")), ".js should be accepted");

  assert(!analyzer.fileFilter(fakeFile("src/app.css", "css")), ".css should be rejected");
  assert(!analyzer.fileFilter(fakeFile("src/app.html", "html")), ".html should be rejected");

  pass("testFileFilter");
}

// ---------------------------------------------------------------------------
// Non-SvelteKit project
// ---------------------------------------------------------------------------

async function testNonSvelteKitReturnsEmpty() {
  const root = await freshProject({
    "src/App.svelte": `<h1>Hello</h1>`,
    "src/main.ts": `import App from "./App.svelte"; new App({ target: document.body });`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new SvelteKitAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  assert(output.patterns.length === 0, "Should have 0 patterns for non-SvelteKit project");

  await rm(root, { recursive: true, force: true });
  pass("testNonSvelteKitReturnsEmpty");
}

// ---------------------------------------------------------------------------
// Page and layout detection
// ---------------------------------------------------------------------------

async function testPageAndLayoutDetection() {
  const root = await freshProject({
    "svelte.config.js": `export default {};`,
    "src/routes/+layout.svelte": `<slot/>`,
    "src/routes/+page.svelte": `<h1>Home</h1>`,
    "src/routes/about/+page.svelte": `<h1>About</h1>`,
    "src/routes/about/+page.ts": `export async function load() { return { title: "About" }; }`,
    "src/routes/+error.svelte": `<h1>Error</h1>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new SvelteKitAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const summary = output.patterns.find((p) => p.name === "sveltekit-framework");
  assert(summary !== undefined, "Should have sveltekit-framework summary");
  assert((summary!.metadata["pageCount"] as number) === 2, `Should detect 2 pages, got ${summary!.metadata["pageCount"]}`);
  assert((summary!.metadata["layoutCount"] as number) === 1, "Should detect 1 layout");

  const homePage = output.patterns.find((p) => p.name === "Page:/");
  assert(homePage !== undefined, "Should detect home page");
  assert(homePage!.type === "page", "Home type should be page");

  const aboutPage = output.patterns.find((p) => p.name === "Page:/about");
  assert(aboutPage !== undefined, "Should detect about page");

  const aboutLoad = output.patterns.find((p) => p.name === "PageServer:/about");
  assert(aboutLoad !== undefined, "Should detect about page server");
  assert(aboutLoad!.metadata["hasLoadFunction"] === true, "Should detect load function");

  const layout = output.patterns.find((p) => p.name === "Layout:/");
  assert(layout !== undefined, "Should detect root layout");
  assert(layout!.type === "layout", "Layout type should be layout");

  const errorComp = output.patterns.find((p) => p.name === "Error:/");
  assert(errorComp !== undefined, "Should detect error component");

  await rm(root, { recursive: true, force: true });
  pass("testPageAndLayoutDetection");
}

// ---------------------------------------------------------------------------
// Server endpoints
// ---------------------------------------------------------------------------

async function testServerEndpoints() {
  const root = await freshProject({
    "svelte.config.js": `export default {};`,
    "src/routes/api/users/+server.ts": `export async function GET() { return new Response(JSON.stringify([])); }`,
    "src/routes/api/users/[id]/+server.ts": `export async function GET({ params }) { return new Response(JSON.stringify({ id: params.id })); }`,
    "src/routes/+page.svelte": `<h1>Home</h1>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new SvelteKitAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const summary = output.patterns.find((p) => p.name === "sveltekit-framework");
  assert((summary!.metadata["serverEndpointCount"] as number) === 2, "Should detect 2 server endpoints");

  const usersEndpoint = output.patterns.find((p) => p.name === "Endpoint:/api/users");
  assert(usersEndpoint !== undefined, "Should detect /api/users endpoint");
  assert(usersEndpoint!.type === "utility", "Endpoint type should be utility");

  const userByIdEndpoint = output.patterns.find((p) => p.filePath.includes("[id]"));
  assert(userByIdEndpoint !== undefined, "Should detect /api/users/:id endpoint");
  assert(userByIdEndpoint!.metadata["routePath"] === "/api/users/:id", `Route should be "/api/users/:id", got "${String(userByIdEndpoint!.metadata["routePath"])}"`);

  await rm(root, { recursive: true, force: true });
  pass("testServerEndpoints");
}

// ---------------------------------------------------------------------------
// Svelte 5 rune detection
// ---------------------------------------------------------------------------

async function testRuneDetection() {
  const root = await freshProject({
    "svelte.config.js": `export default {};`,
    "src/routes/+page.svelte": `<script>
  let count = $state(0);
  let doubled = $derived(count * 2);
  $effect(() => { console.log(count); });
</script>
<button on:click={() => count++}>{count} (doubled: {doubled})</button>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new SvelteKitAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const summary = output.patterns.find((p) => p.name === "sveltekit-framework");
  const runesUsed = summary!.metadata["runesUsed"] as string[];
  assert(Array.isArray(runesUsed), "runesUsed should be array");
  assert(runesUsed.includes("$state"), "Should detect $state rune");
  assert(runesUsed.includes("$derived"), "Should detect $derived rune");
  assert(runesUsed.includes("$effect"), "Should detect $effect rune");
  assert(summary!.metadata["usesSvelte5Runes"] === true, "Should flag Svelte 5 runes");

  const page = output.patterns.find((p) => p.name === "Page:/");
  assert(page !== undefined, "Should detect page");
  const pageRunes = page!.metadata["runesUsed"] as string[];
  assert(pageRunes.includes("$state"), "Page should have $state");

  await rm(root, { recursive: true, force: true });
  pass("testRuneDetection");
}

// ---------------------------------------------------------------------------
// Form actions
// ---------------------------------------------------------------------------

async function testFormActions() {
  const root = await freshProject({
    "svelte.config.js": `export default {};`,
    "src/routes/login/+page.svelte": `<form method="POST"><button>Log in</button></form>`,
    "src/routes/login/+page.server.ts": `export const actions = {
  default: async ({ request }) => {
    const data = await request.formData();
    return { success: true };
  }
};
export async function load() { return { title: "Login" }; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new SvelteKitAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const summary = output.patterns.find((p) => p.name === "sveltekit-framework");
  assert((summary!.metadata["formActionCount"] as number) >= 1, "Should detect form actions");

  const loginServer = output.patterns.find((p) => p.name === "PageServer:/login");
  assert(loginServer !== undefined, "Should detect login page server");
  assert(loginServer!.metadata["hasFormActions"] === true, "Should detect form actions");
  assert(loginServer!.metadata["hasLoadFunction"] === true, "Should detect load function");

  await rm(root, { recursive: true, force: true });
  pass("testFormActions");
}

// ---------------------------------------------------------------------------
// Hooks detection
// ---------------------------------------------------------------------------

async function testHooksDetection() {
  const root = await freshProject({
    "svelte.config.js": `export default {};`,
    "src/hooks.server.ts": `export async function handle({ event, resolve }) { return resolve(event); }`,
    "src/routes/+page.svelte": `<h1>Home</h1>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new SvelteKitAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const summary = output.patterns.find((p) => p.name === "sveltekit-framework");
  assert(summary!.metadata["hooksDetected"] === true, "Should detect hooks");

  const hooks = output.patterns.find((p) => p.name === "HooksServer");
  assert(hooks !== undefined, "Should detect hooks.server");
  assert(hooks!.metadata["hasHandle"] === true, "Should detect handle export");

  await rm(root, { recursive: true, force: true });
  pass("testHooksDetection");
}

// ---------------------------------------------------------------------------
// Route groups and dynamic routes
// ---------------------------------------------------------------------------

async function testRouteGroupsAndDynamic() {
  const root = await freshProject({
    "svelte.config.js": `export default {};`,
    "src/routes/(marketing)/+page.svelte": `<h1>Marketing Home</h1>`,
    "src/routes/(marketing)/pricing/+page.svelte": `<h1>Pricing</h1>`,
    "src/routes/(app)/dashboard/+page.svelte": `<h1>Dashboard</h1>`,
    "src/routes/blog/[slug]/+page.svelte": `<h1>Post</h1>`,
    "src/routes/docs/[...path]/+page.svelte": `<h1>Docs</h1>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new SvelteKitAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const summary = output.patterns.find((p) => p.name === "sveltekit-framework");
  const routeGroups = summary!.metadata["routeGroups"] as string[];
  assert(routeGroups.includes("marketing"), "Should detect marketing group");
  assert(routeGroups.includes("app"), "Should detect app group");

  // Route groups should not appear in route paths
  const marketingHome = output.patterns.find((p) => p.filePath.includes("(marketing)/+page"));
  assert(marketingHome !== undefined, "Should detect marketing home");
  assert(marketingHome!.metadata["routePath"] === "/", `Marketing home should be "/", got "${String(marketingHome!.metadata["routePath"])}"`);

  const pricing = output.patterns.find((p) => p.filePath.includes("pricing"));
  assert(pricing !== undefined, "Should detect pricing");
  assert(pricing!.metadata["routePath"] === "/pricing", `Pricing should be "/pricing", got "${String(pricing!.metadata["routePath"])}"`);

  // Dynamic routes
  const blogPost = output.patterns.find((p) => p.filePath.includes("[slug]"));
  assert(blogPost !== undefined, "Should detect blog post");
  assert(blogPost!.metadata["routePath"] === "/blog/:slug", `Blog route should be "/blog/:slug", got "${String(blogPost!.metadata["routePath"])}"`);

  const docs = output.patterns.find((p) => p.filePath.includes("[...path]"));
  assert(docs !== undefined, "Should detect docs");
  assert(docs!.metadata["routePath"] === "/docs/*path", `Docs route should be "/docs/*path", got "${String(docs!.metadata["routePath"])}"`);

  await rm(root, { recursive: true, force: true });
  pass("testRouteGroupsAndDynamic");
}

// ---------------------------------------------------------------------------
// Deterministic hash
// ---------------------------------------------------------------------------

async function testDeterministicHash() {
  const root = await freshProject({
    "svelte.config.js": `export default {};`,
    "src/routes/+page.svelte": `<h1>Home</h1>`,
    "src/routes/+layout.svelte": `<slot/>`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new SvelteKitAnalyzer();
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

  assert(output1.hash === output2.hash, "Hashes should match");
  assert(output1.patterns.length === output2.patterns.length, "Pattern counts should match");

  await rm(root, { recursive: true, force: true });
  pass("testDeterministicHash");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("SvelteKit Analyzer tests\n");

  testInterface();
  testFileFilter();

  await testNonSvelteKitReturnsEmpty();
  await testPageAndLayoutDetection();
  await testServerEndpoints();
  await testRuneDetection();
  await testFormActions();
  await testHooksDetection();
  await testRouteGroupsAndDynamic();
  await testDeterministicHash();

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
