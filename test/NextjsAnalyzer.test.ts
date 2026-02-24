import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextjsAnalyzer } from "../src/analyzers/NextjsAnalyzer.js";
import { FileDiscovery } from "../src/core/FileDiscovery.js";
import type {
  DiscoveredFile,
  FileHash,
  AnalyzerId,
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

const ROOT = join(tmpdir(), "uiq-nextjs-test-" + Date.now());

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

function testNextjsAnalyzerInterface() {
  const analyzer = new NextjsAnalyzer();

  assert(analyzer.name === "nextjs", `name should be "nextjs", got "${analyzer.name}"`);
  assert(analyzer.version === "1.0.0", `version should be "1.0.0", got "${analyzer.version}"`);
  assert(analyzer.capabilities.includes("nextjs-router-detection"), "should have nextjs-router-detection");
  assert(analyzer.capabilities.includes("server-client-classification"), "should have server-client-classification");
  assert(analyzer.capabilities.includes("layout-hierarchy"), "should have layout-hierarchy");
  assert(analyzer.capabilities.includes("middleware-detection"), "should have middleware-detection");
  assert(analyzer.dependencies !== undefined && analyzer.dependencies.includes("component"), "should depend on component");

  pass("testNextjsAnalyzerInterface");
}

function testNextjsAnalyzerFileFilter() {
  const analyzer = new NextjsAnalyzer();

  assert(analyzer.fileFilter(fakeFile("app/page.tsx", "tsx")), ".tsx should be accepted");
  assert(analyzer.fileFilter(fakeFile("app/layout.ts", "ts")), ".ts should be accepted");
  assert(analyzer.fileFilter(fakeFile("pages/index.js", "js")), ".js should be accepted");
  assert(analyzer.fileFilter(fakeFile("pages/about.jsx", "jsx")), ".jsx should be accepted");

  assert(!analyzer.fileFilter(fakeFile("src/style.css", "css")), ".css should be rejected");
  assert(!analyzer.fileFilter(fakeFile("src/App.vue", "vue")), ".vue should be rejected");
  assert(!analyzer.fileFilter(fakeFile("src/Nav.svelte", "svelte")), ".svelte should be rejected");

  pass("testNextjsAnalyzerFileFilter");
}

// ---------------------------------------------------------------------------
// Non-Next.js project returns empty
// ---------------------------------------------------------------------------

async function testNonNextjsProjectReturnsEmpty() {
  const root = await freshProject({
    "src/App.tsx": `export function App() { return <div/>; }`,
    "src/utils.ts": `export const add = (a: number, b: number) => a + b;`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  assert(output.patterns.length === 0, `Non-Next.js should have 0 patterns, got ${output.patterns.length}`);
  assert(output.diagnostics.length === 0, `Non-Next.js should have 0 diagnostics`);
  assert(output.stats.analyzedFiles === 0, "analyzedFiles should be 0");

  await rm(root, { recursive: true, force: true });
  pass("testNonNextjsProjectReturnsEmpty");
}

// ---------------------------------------------------------------------------
// App Router detection
// ---------------------------------------------------------------------------

async function testAppRouterDetection() {
  const root = await freshProject({
    "next.config.ts": `export default {};`,
    "app/layout.tsx": `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
    "app/page.tsx": `export default function Home() { return <main>Hello</main>; }`,
    "app/about/page.tsx": `export default function About() { return <h1>About</h1>; }`,
    "app/loading.tsx": `export default function Loading() { return <div>Loading...</div>; }`,
    "app/error.tsx": `"use client";\nexport default function Error() { return <div>Error!</div>; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  // Should have router summary pattern + per-file patterns
  const routerPattern = output.patterns.find((p) => p.name === "nextjs-router");
  assert(routerPattern !== undefined, "Should have nextjs-router pattern");
  assert(routerPattern!.metadata["routerKind"] === "app", `routerKind should be "app", got "${String(routerPattern!.metadata["routerKind"])}"`);
  assert((routerPattern!.metadata["appRouterPageCount"] as number) === 2, "Should detect 2 app pages");
  assert((routerPattern!.metadata["layoutCount"] as number) === 1, "Should detect 1 layout");

  // Check pages detected
  const homePage = output.patterns.find((p) => p.name === "Page:/");
  assert(homePage !== undefined, "Should detect home page");
  assert(homePage!.type === "page", "Home page type should be page");

  const aboutPage = output.patterns.find((p) => p.name === "Page:/about");
  assert(aboutPage !== undefined, "Should detect about page");

  // Check layout detected
  const layout = output.patterns.find((p) => p.name === "Layout:/");
  assert(layout !== undefined, "Should detect root layout");
  assert(layout!.type === "layout", "Layout type should be layout");

  // Check loading detected
  const loading = output.patterns.find((p) => p.metadata["nextjsRole"] === "loading");
  assert(loading !== undefined, "Should detect loading component");

  // Check error has "use client"
  const errorComp = output.patterns.find((p) => p.metadata["nextjsRole"] === "error");
  assert(errorComp !== undefined, "Should detect error component");
  assert(errorComp!.metadata["isClientComponent"] === true, "Error should be client component");

  await rm(root, { recursive: true, force: true });
  pass("testAppRouterDetection");
}

// ---------------------------------------------------------------------------
// Pages Router detection
// ---------------------------------------------------------------------------

async function testPagesRouterDetection() {
  const root = await freshProject({
    "next.config.js": `module.exports = {};`,
    "pages/index.tsx": `export default function Home() { return <div>Home</div>; }`,
    "pages/about.tsx": `export default function About() { return <div>About</div>; }`,
    "pages/api/hello.ts": `export default function handler(req, res) { res.json({ text: "Hello" }); }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const routerPattern = output.patterns.find((p) => p.name === "nextjs-router");
  assert(routerPattern !== undefined, "Should have nextjs-router pattern");
  assert(routerPattern!.metadata["routerKind"] === "pages", `routerKind should be "pages", got "${String(routerPattern!.metadata["routerKind"])}"`);
  assert((routerPattern!.metadata["pagesRouterPageCount"] as number) === 2, "Should detect 2 pages");
  assert((routerPattern!.metadata["apiRouteCount"] as number) === 1, "Should detect 1 API route");

  // Check API route
  const apiRoute = output.patterns.find((p) => p.metadata["nextjsRole"] === "api-route");
  assert(apiRoute !== undefined, "Should detect API route");
  assert(apiRoute!.type === "utility", "API route type should be utility");

  await rm(root, { recursive: true, force: true });
  pass("testPagesRouterDetection");
}

// ---------------------------------------------------------------------------
// Server/Client component classification
// ---------------------------------------------------------------------------

async function testServerClientClassification() {
  const root = await freshProject({
    "next.config.ts": `export default {};`,
    "app/page.tsx": `export default function Home() { return <div>Home</div>; }`,
    "app/components/ClientButton.tsx": `"use client";\nexport function ClientButton() { return <button>Click</button>; }`,
    "app/components/ServerList.tsx": `export function ServerList() { return <ul><li>Item</li></ul>; }`,
    "app/actions.ts": `"use server";\nexport async function saveData() { /* ... */ }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const clientButton = output.patterns.find((p) => p.filePath.includes("ClientButton"));
  assert(clientButton !== undefined, "Should detect ClientButton");
  assert(clientButton!.metadata["isClientComponent"] === true, "ClientButton should be client component");
  assert(clientButton!.metadata["nextjsRole"] === "client-component", "ClientButton role should be client-component");

  const serverList = output.patterns.find((p) => p.filePath.includes("ServerList"));
  assert(serverList !== undefined, "Should detect ServerList");
  assert(serverList!.metadata["nextjsRole"] === "server-component", "ServerList role should be server-component");

  const actions = output.patterns.find((p) => p.filePath.includes("actions"));
  assert(actions !== undefined, "Should detect actions file");
  assert(actions!.metadata["isServerAction"] === true, "Actions should have isServerAction");

  await rm(root, { recursive: true, force: true });
  pass("testServerClientClassification");
}

// ---------------------------------------------------------------------------
// Route groups
// ---------------------------------------------------------------------------

async function testRouteGroups() {
  const root = await freshProject({
    "next.config.ts": `export default {};`,
    "app/(marketing)/page.tsx": `export default function MarketingHome() { return <div>Marketing</div>; }`,
    "app/(marketing)/about/page.tsx": `export default function About() { return <div>About</div>; }`,
    "app/(dashboard)/settings/page.tsx": `export default function Settings() { return <div>Settings</div>; }`,
    "app/(dashboard)/layout.tsx": `export default function DashboardLayout({ children }: any) { return <div>{children}</div>; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const routerPattern = output.patterns.find((p) => p.name === "nextjs-router");
  assert(routerPattern !== undefined, "Should have nextjs-router pattern");

  const routeGroups = routerPattern!.metadata["routeGroups"] as string[];
  assert(Array.isArray(routeGroups), "routeGroups should be array");
  assert(routeGroups.includes("marketing"), `Should detect "marketing" group`);
  assert(routeGroups.includes("dashboard"), `Should detect "dashboard" group`);

  // Route group dirs should NOT appear in route paths
  const marketingPage = output.patterns.find((p) => p.filePath.includes("(marketing)/page"));
  assert(marketingPage !== undefined, "Should detect marketing page");
  assert(marketingPage!.metadata["routePath"] === "/", `Marketing home route should be "/", got "${String(marketingPage!.metadata["routePath"])}"`);
  assert(marketingPage!.metadata["routeGroup"] === "marketing", "Should record route group");

  const aboutPage = output.patterns.find((p) => p.filePath.includes("(marketing)/about/page"));
  assert(aboutPage !== undefined, "Should detect about page");
  assert(aboutPage!.metadata["routePath"] === "/about", `About route should be "/about", got "${String(aboutPage!.metadata["routePath"])}"`);

  await rm(root, { recursive: true, force: true });
  pass("testRouteGroups");
}

// ---------------------------------------------------------------------------
// Dynamic routes
// ---------------------------------------------------------------------------

async function testDynamicRoutes() {
  const root = await freshProject({
    "next.config.ts": `export default {};`,
    "app/blog/[slug]/page.tsx": `export default function BlogPost() { return <div>Post</div>; }`,
    "app/shop/[...categories]/page.tsx": `export default function Shop() { return <div>Shop</div>; }`,
    "app/docs/[[...path]]/page.tsx": `export default function Docs() { return <div>Docs</div>; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const routerPattern = output.patterns.find((p) => p.name === "nextjs-router");
  assert((routerPattern!.metadata["dynamicRouteCount"] as number) === 3, "Should detect 3 dynamic routes");

  const blogPost = output.patterns.find((p) => p.filePath.includes("[slug]"));
  assert(blogPost !== undefined, "Should detect blog post page");
  assert(blogPost!.metadata["routePath"] === "/blog/:slug", `Blog route should be "/blog/:slug", got "${String(blogPost!.metadata["routePath"])}"`);

  const dynamicSegments = blogPost!.metadata["dynamicSegments"] as string[];
  assert(dynamicSegments.includes("slug"), "Should detect slug segment");

  const shop = output.patterns.find((p) => p.filePath.includes("[...categories]"));
  assert(shop !== undefined, "Should detect shop page");
  assert(shop!.metadata["routePath"] === "/shop/*categories", `Shop route should be "/shop/*categories", got "${String(shop!.metadata["routePath"])}"`);

  const docs = output.patterns.find((p) => p.filePath.includes("[[...path]]"));
  assert(docs !== undefined, "Should detect docs page");
  assert(docs!.metadata["routePath"] === "/docs/*path?", `Docs route should be "/docs/*path?", got "${String(docs!.metadata["routePath"])}"`);

  await rm(root, { recursive: true, force: true });
  pass("testDynamicRoutes");
}

// ---------------------------------------------------------------------------
// Middleware detection
// ---------------------------------------------------------------------------

async function testMiddlewareDetection() {
  const root = await freshProject({
    "next.config.ts": `export default {};`,
    "middleware.ts": `import { NextResponse } from "next/server";
export function middleware(request: any) { return NextResponse.next(); }
export const config = { matcher: ["/about/:path*", "/dashboard/:path*"] };`,
    "app/page.tsx": `export default function Home() { return <div>Home</div>; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const middleware = output.patterns.find((p) => p.name === "Middleware");
  assert(middleware !== undefined, "Should detect middleware");
  assert(middleware!.metadata["nextjsRole"] === "middleware", "Should have middleware role");
  assert(middleware!.type === "utility", "Middleware type should be utility");

  const routerPattern = output.patterns.find((p) => p.name === "nextjs-router");
  assert(routerPattern!.metadata["middlewareDetected"] === true, "Should flag middleware detected");

  await rm(root, { recursive: true, force: true });
  pass("testMiddlewareDetection");
}

// ---------------------------------------------------------------------------
// Route handlers (App Router API)
// ---------------------------------------------------------------------------

async function testRouteHandlers() {
  const root = await freshProject({
    "next.config.ts": `export default {};`,
    "app/api/users/route.ts": `export async function GET() { return Response.json({ users: [] }); }
export async function POST() { return Response.json({ ok: true }); }`,
    "app/api/users/[id]/route.ts": `export async function GET() { return Response.json({}); }
export async function DELETE() { return Response.json({ deleted: true }); }`,
    "app/page.tsx": `export default function Home() { return <div>Home</div>; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const routeHandlers = output.patterns.filter((p) => p.metadata["nextjsRole"] === "route-handler");
  assert(routeHandlers.length === 2, `Should detect 2 route handlers, got ${routeHandlers.length}`);

  const usersRoute = routeHandlers.find((p) => p.filePath.includes("api/users/route"));
  assert(usersRoute !== undefined, "Should detect users route handler");
  assert(usersRoute!.metadata["routePath"] === "/api/users", `Users route path should be "/api/users", got "${String(usersRoute!.metadata["routePath"])}"`);

  const userByIdRoute = routeHandlers.find((p) => p.filePath.includes("[id]/route"));
  assert(userByIdRoute !== undefined, "Should detect user by id route handler");
  assert(userByIdRoute!.metadata["routePath"] === "/api/users/:id", `User by id route path should be "/api/users/:id", got "${String(userByIdRoute!.metadata["routePath"])}"`);

  await rm(root, { recursive: true, force: true });
  pass("testRouteHandlers");
}

// ---------------------------------------------------------------------------
// Hybrid router detection
// ---------------------------------------------------------------------------

async function testHybridRouterDetection() {
  const root = await freshProject({
    "next.config.ts": `export default {};`,
    "app/page.tsx": `export default function Home() { return <div>Home</div>; }`,
    "app/layout.tsx": `export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }`,
    "pages/legacy.tsx": `export default function Legacy() { return <div>Old page</div>; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const routerPattern = output.patterns.find((p) => p.name === "nextjs-router");
  assert(routerPattern!.metadata["routerKind"] === "hybrid", `Should be hybrid, got "${String(routerPattern!.metadata["routerKind"])}"`);

  // Should have info diagnostic about hybrid usage
  const hybridDiag = output.diagnostics.find((d) => d.message.includes("both App Router and Pages Router"));
  assert(hybridDiag !== undefined, "Should have hybrid router diagnostic");

  await rm(root, { recursive: true, force: true });
  pass("testHybridRouterDetection");
}

// ---------------------------------------------------------------------------
// Diagnostics for missing default export
// ---------------------------------------------------------------------------

async function testMissingDefaultExportDiagnostic() {
  const root = await freshProject({
    "next.config.ts": `export default {};`,
    "app/page.tsx": `export function Home() { return <div>Home</div>; }`, // No default export
    "app/layout.tsx": `export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const missingExportDiag = output.diagnostics.find(
    (d) => d.message.includes("does not have a default export") && d.filePath.includes("page"),
  );
  assert(missingExportDiag !== undefined, "Should warn about missing default export on page");
  assert(missingExportDiag!.severity === "warning", "Should be a warning");

  await rm(root, { recursive: true, force: true });
  pass("testMissingDefaultExportDiagnostic");
}

// ---------------------------------------------------------------------------
// Deterministic hash
// ---------------------------------------------------------------------------

async function testDeterministicHash() {
  const root = await freshProject({
    "next.config.ts": `export default {};`,
    "app/page.tsx": `export default function Home() { return <div>Home</div>; }`,
    "app/layout.tsx": `export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();
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

  assert(output1.hash === output2.hash, `Hashes should match: "${output1.hash}" vs "${output2.hash}"`);
  assert(output1.patterns.length === output2.patterns.length, "Pattern counts should match");

  await rm(root, { recursive: true, force: true });
  pass("testDeterministicHash");
}

// ---------------------------------------------------------------------------
// src/app directory structure (common in many projects)
// ---------------------------------------------------------------------------

async function testSrcAppDirectory() {
  const root = await freshProject({
    "next.config.ts": `export default {};`,
    "src/app/layout.tsx": `export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }`,
    "src/app/page.tsx": `export default function Home() { return <div>Home</div>; }`,
    "src/app/dashboard/page.tsx": `export default function Dashboard() { return <div>Dashboard</div>; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const routerPattern = output.patterns.find((p) => p.name === "nextjs-router");
  assert(routerPattern !== undefined, "Should detect router in src/app");
  assert(routerPattern!.metadata["routerKind"] === "app", "Should be app router");
  assert((routerPattern!.metadata["appRouterPageCount"] as number) === 2, "Should detect 2 pages in src/app");

  const dashPage = output.patterns.find((p) => p.name === "Page:/dashboard");
  assert(dashPage !== undefined, "Should detect dashboard page");

  await rm(root, { recursive: true, force: true });
  pass("testSrcAppDirectory");
}

// ---------------------------------------------------------------------------
// Client layout diagnostic
// ---------------------------------------------------------------------------

async function testClientLayoutDiagnostic() {
  const root = await freshProject({
    "next.config.ts": `export default {};`,
    "app/layout.tsx": `"use client";\nexport default function Layout({ children }: any) { return <div>{children}</div>; }`,
    "app/page.tsx": `export default function Home() { return <div>Home</div>; }`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const analyzer = new NextjsAnalyzer();

  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const clientLayoutDiag = output.diagnostics.find(
    (d) => d.message.includes("use client") && d.filePath.includes("layout"),
  );
  assert(clientLayoutDiag !== undefined, "Should warn about client layout");
  assert(clientLayoutDiag!.severity === "info", "Should be info severity");

  await rm(root, { recursive: true, force: true });
  pass("testClientLayoutDiagnostic");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Next.js Analyzer tests\n");

  // Sync tests
  testNextjsAnalyzerInterface();
  testNextjsAnalyzerFileFilter();

  // Async tests
  await testNonNextjsProjectReturnsEmpty();
  await testAppRouterDetection();
  await testPagesRouterDetection();
  await testServerClientClassification();
  await testRouteGroups();
  await testDynamicRoutes();
  await testMiddlewareDetection();
  await testRouteHandlers();
  await testHybridRouterDetection();
  await testMissingDefaultExportDiagnostic();
  await testDeterministicHash();
  await testSrcAppDirectory();
  await testClientLayoutDiagnostic();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

  // Cleanup
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
