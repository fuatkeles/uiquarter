import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ImportAnalyzer } from "../src/analyzers/ImportAnalyzer.js";
import { ComponentAnalyzer } from "../src/analyzers/ComponentAnalyzer.js";
import { StylingAnalyzer } from "../src/analyzers/StylingAnalyzer.js";
import { FileStructureAnalyzer } from "../src/analyzers/FileStructureAnalyzer.js";
import { DependencyAnalyzer } from "../src/analyzers/DependencyAnalyzer.js";
import { StructureAnalyzer } from "../src/analyzers/stubs.js";
import { AnalyzerOrchestrator } from "../src/core/AnalyzerOrchestrator.js";
import { FileDiscovery } from "../src/core/FileDiscovery.js";
import { normalizeOutput } from "../src/core/normalizer.js";
import { IntelligenceIndexer } from "../src/indexer/IntelligenceIndexer.js";
import type {
  DiscoveredFile,
  FileHash,
  AnalyzerId,
  CacheAccessor,
} from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const ROOT = join(tmpdir(), "uiq-analyzers-test-" + Date.now());

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
// ImportAnalyzer tests
// ---------------------------------------------------------------------------

async function testImportAnalyzerInterface() {
  const analyzer = new ImportAnalyzer();

  assert(analyzer.name === "import", `name should be "import", got "${analyzer.name}"`);
  assert(analyzer.version === "1.0.0", `version should be "1.0.0", got "${analyzer.version}"`);
  assert(analyzer.capabilities.includes("import-resolution"), "should have import-resolution capability");
  assert(analyzer.capabilities.includes("dependency-graph"), "should have dependency-graph capability");

  console.log("PASS: testImportAnalyzerInterface");
}

async function testImportAnalyzerFileFilter() {
  const analyzer = new ImportAnalyzer();

  // Should accept
  assert(analyzer.fileFilter(fakeFile("src/app.ts", "ts")), ".ts should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.tsx", "tsx")), ".tsx should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.js", "js")), ".js should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.jsx", "jsx")), ".jsx should be accepted");

  // Should reject
  assert(!analyzer.fileFilter(fakeFile("src/app.vue", "vue")), ".vue should be rejected");
  assert(!analyzer.fileFilter(fakeFile("src/app.svelte", "svelte")), ".svelte should be rejected");
  assert(!analyzer.fileFilter(fakeFile("src/style.css", "css")), ".css should be rejected");
  assert(!analyzer.fileFilter(fakeFile("src/style.scss", "scss")), ".scss should be rejected");

  console.log("PASS: testImportAnalyzerFileFilter");
}

async function testImportAnalyzerEmptyOutput() {
  const analyzer = new ImportAnalyzer();
  const files = [fakeFile("src/app.ts", "ts"), fakeFile("src/utils.ts", "ts")];

  const output = await analyzer.analyze({
    rootPath: "/fake",
    files,
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  assert(output.analyzerId === ("import@1.0.0" as AnalyzerId), `analyzerId should be "import@1.0.0", got "${output.analyzerId}"`);
  assert(output.patterns.length === 0, "Should return 0 patterns");
  assert(output.diagnostics.length === 0, "Should return 0 diagnostics");
  assert(typeof output.hash === "string" && (output.hash as string).length === 64, "Hash should be 64-char hex");
  assert(typeof output.duration === "number", "Duration should be a number");
  assert(output.stats.totalFiles === 2, `totalFiles should be 2, got ${output.stats.totalFiles}`);
  assert(output.stats.analyzedFiles === 0, "analyzedFiles should be 0 (stub)");

  console.log("PASS: testImportAnalyzerEmptyOutput");
}

// ---------------------------------------------------------------------------
// ComponentAnalyzer tests
// ---------------------------------------------------------------------------

async function testComponentAnalyzerInterface() {
  const analyzer = new ComponentAnalyzer();

  assert(analyzer.name === "component", `name should be "component", got "${analyzer.name}"`);
  assert(analyzer.version === "1.0.0", `version should be "1.0.0"`);
  assert(analyzer.capabilities.includes("component-detection"), "should have component-detection");
  assert(analyzer.capabilities.includes("prop-extraction"), "should have prop-extraction");
  assert(analyzer.capabilities.includes("hook-detection"), "should have hook-detection");
  assert(analyzer.capabilities.includes("jsx-analysis"), "should have jsx-analysis");
  assert(analyzer.dependencies !== undefined && analyzer.dependencies.includes("import"), "should depend on import");

  console.log("PASS: testComponentAnalyzerInterface");
}

async function testComponentAnalyzerFileFilter() {
  const analyzer = new ComponentAnalyzer();

  // Should accept
  assert(analyzer.fileFilter(fakeFile("src/Button.tsx", "tsx")), ".tsx should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/Button.jsx", "jsx")), ".jsx should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/Card.vue", "vue")), ".vue should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/Nav.svelte", "svelte")), ".svelte should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/useAuth.ts", "ts")), ".ts should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/useAuth.js", "js")), ".js should be accepted");

  // Should reject
  assert(!analyzer.fileFilter(fakeFile("src/style.css", "css")), ".css should be rejected");

  console.log("PASS: testComponentAnalyzerFileFilter");
}

async function testComponentAnalyzerDetectsFunctionComponent() {
  const root = await freshProject({
    "src/Button.tsx": `export function Button(props: { label: string }) {
  return <button>{props.label}</button>;
}`,
  });
  const files = await new FileDiscovery({ rootPath: root }).discover();

  const importAnalyzer = new ImportAnalyzer();
  const importOutput = await importAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => importAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const analyzer = new ComponentAnalyzer();
  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([["import", importOutput]]),
  });

  const button = output.patterns.find((p) => p.name === "Button");
  assert(button !== undefined, "Button component should be detected");
  assert(button!.type === "component", `Button type should be component, got "${button!.type}"`);
  assert(button!.properties["label"] !== undefined, "Button should expose label prop");
  assert(button!.properties["label"]!.type === "string", "label prop should be string");

  console.log("PASS: testComponentAnalyzerDetectsFunctionComponent");
}

async function testComponentAnalyzerDetectsArrowComponent() {
  const root = await freshProject({
    "src/Card.tsx": "export const Card = ({ title }: { title: string }) => <section>{title}</section>;",
  });
  const files = await new FileDiscovery({ rootPath: root }).discover();

  const importAnalyzer = new ImportAnalyzer();
  const importOutput = await importAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => importAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const analyzer = new ComponentAnalyzer();
  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([["import", importOutput]]),
  });

  const card = output.patterns.find((p) => p.name === "Card");
  assert(card !== undefined, "Card component should be detected");
  assert(card!.metadata.componentKind === "arrow-function", `Card componentKind should be arrow-function, got "${String(card!.metadata.componentKind)}"`);

  console.log("PASS: testComponentAnalyzerDetectsArrowComponent");
}

async function testComponentAnalyzerDetectsHook() {
  const root = await freshProject({
    "src/hooks/useAuth.ts": `import { useState, useEffect } from "react";
export function useAuth(userId: string) {
  const [value] = useState(userId);
  useEffect(() => {}, []);
  return value;
}`,
  });
  const files = await new FileDiscovery({ rootPath: root }).discover();

  const importAnalyzer = new ImportAnalyzer();
  const importOutput = await importAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => importAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const analyzer = new ComponentAnalyzer();
  const output = await analyzer.analyze({
    rootPath: root,
    files: files.filter((f) => analyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([["import", importOutput]]),
  });

  const hook = output.patterns.find((p) => p.name === "useAuth");
  assert(hook !== undefined, "useAuth hook should be detected");
  assert(hook!.type === "hook", `useAuth type should be hook, got "${hook!.type}"`);

  const hookCalls = hook!.metadata.hookCalls as string[] | undefined;
  assert(Array.isArray(hookCalls), "hookCalls should exist");
  assert(hookCalls!.includes("useEffect"), "hookCalls should include useEffect");
  assert(hookCalls!.includes("useState"), "hookCalls should include useState");

  console.log("PASS: testComponentAnalyzerDetectsHook");
}

async function testComponentAnalyzerDeterministicHash() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() { return <div />; }",
  });
  const files = await new FileDiscovery({ rootPath: root }).discover();
  const component = new ComponentAnalyzer();
  const componentFiles = files.filter((f) => component.fileFilter(f));

  const importAnalyzer = new ImportAnalyzer();
  const importOutput = await importAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => importAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const ctx = {
    rootPath: root,
    files: componentFiles,
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([["import", importOutput]]),
  };

  const o1 = await component.analyze(ctx);
  const o2 = await component.analyze(ctx);

  assert(o1.hash === o2.hash, "Two runs with same input should produce identical hashes");
  console.log("PASS: testComponentAnalyzerDeterministicHash");
}

async function testComponentAnalyzerIntegrationWithImportAnalyzer() {
  const root = await freshProject({
    "src/Icon.tsx": "export function Icon() { return <span />; }",
    "src/Button.tsx": `import { Icon } from "./Icon";
export function Button() {
  return <div><Icon /></div>;
}`,
  });
  const files = await new FileDiscovery({ rootPath: root }).discover();

  const importAnalyzer = new ImportAnalyzer();
  const importOutput = await importAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => importAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const componentAnalyzer = new ComponentAnalyzer();
  const componentOutput = await componentAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => componentAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([["import", importOutput]]),
  });

  const button = componentOutput.patterns.find((p) => p.name === "Button");
  assert(button !== undefined, "Button should be detected");
  assert(button!.dependencies.length > 0, "Button should have at least one dependency");
  assert(
    button!.dependencies.some((dep) => (dep as string).startsWith("src/Icon.tsx:Icon:")),
    `Button dependencies should include Icon pattern id, got: ${button!.dependencies.join(", ")}`,
  );

  console.log("PASS: testComponentAnalyzerIntegrationWithImportAnalyzer");
}

// ---------------------------------------------------------------------------
// StylingAnalyzer tests
// ---------------------------------------------------------------------------

async function analyzeStylingProject(root: string) {
  const files = await new FileDiscovery({ rootPath: root }).discover();

  const importAnalyzer = new ImportAnalyzer();
  const importOutput = await importAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => importAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const stylingAnalyzer = new StylingAnalyzer();
  const output = await stylingAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => stylingAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([["import", importOutput]]),
  });

  return { files, importOutput, output };
}

async function testStylingAnalyzerInterface() {
  const analyzer = new StylingAnalyzer();

  assert(analyzer.name === "styling", `name should be "styling", got "${analyzer.name}"`);
  assert(analyzer.version === "1.0.0", `version should be "1.0.0"`);
  assert(analyzer.capabilities.includes("tailwind-detection"), "should have tailwind-detection");
  assert(analyzer.capabilities.includes("css-modules-detection"), "should have css-modules-detection");
  assert(analyzer.capabilities.includes("css-in-js-detection"), "should have css-in-js-detection");
  assert(analyzer.capabilities.includes("design-token-detection"), "should have design-token-detection");
  assert(analyzer.capabilities.includes("styling-system-classification"), "should have styling-system-classification");
  assert(analyzer.dependencies !== undefined && analyzer.dependencies.includes("import"), "should depend on import");

  console.log("PASS: testStylingAnalyzerInterface");
}

async function testStylingAnalyzerFileFilter() {
  const analyzer = new StylingAnalyzer();

  // Should accept
  assert(analyzer.fileFilter(fakeFile("src/style.css", "css")), ".css should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/style.scss", "scss")), ".scss should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/style.sass", "sass")), ".sass should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/style.less", "less")), ".less should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/utils.ts", "ts")), ".ts should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/Button.tsx", "tsx")), ".tsx should be accepted (CSS-in-JS)");
  assert(analyzer.fileFilter(fakeFile("src/utils.js", "js")), ".js should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/Button.jsx", "jsx")), ".jsx should be accepted (CSS-in-JS)");
  assert(analyzer.fileFilter(fakeFile("src/file.mjs", "mjs")), ".mjs should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/file.cjs", "cjs")), ".cjs should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/Card.vue", "vue")), ".vue should be accepted (scoped styles)");
  assert(analyzer.fileFilter(fakeFile("src/Nav.svelte", "svelte")), ".svelte should be accepted (scoped styles)");

  // Should reject
  assert(!analyzer.fileFilter(fakeFile("src/data.json", "json")), ".json should be rejected");
  assert(!analyzer.fileFilter(fakeFile("src/logo.svg", "svg")), ".svg should be rejected");

  console.log("PASS: testStylingAnalyzerFileFilter");
}

async function testStylingAnalyzerDetectsCssFile() {
  const root = await freshProject({
    "src/style.css": `
:root {
  --color-primary: #ff0000;
}
.btn {
  color: var(--color-primary);
}
`,
  });

  const { output } = await analyzeStylingProject(root);

  assert(output.analyzerId === ("styling@1.0.0" as AnalyzerId), `analyzerId should be "styling@1.0.0"`);

  const stylesheet = output.patterns.find((p) => p.id === "src/style.css:stylesheet:1");
  assert(stylesheet !== undefined, "Should detect stylesheet pattern for css file");
  assert(stylesheet!.name === "stylesheet", `stylesheet pattern name should be "stylesheet", got "${stylesheet!.name}"`);
  assert(stylesheet!.metadata["technology"] === "plain-css", `technology should be plain-css, got "${String(stylesheet!.metadata["technology"])}"`);

  const profile = output.patterns.find((p) => p.id === ".:styling-profile:1");
  assert(profile !== undefined, "Should include project styling profile pattern");

  console.log("PASS: testStylingAnalyzerDetectsCssFile");
}

async function testStylingAnalyzerDetectsCssModules() {
  const root = await freshProject({
    "src/Button.module.css": ".root { color: red; }",
    "src/Button.tsx": `import styles from "./Button.module.css";
export function Button() {
  return <button className={styles.root}>Click</button>;
}`,
  });

  const { output } = await analyzeStylingProject(root);

  const stylesheet = output.patterns.find((p) => p.id === "src/Button.module.css:stylesheet:1");
  assert(stylesheet !== undefined, "Should emit stylesheet pattern for css module");
  assert(stylesheet!.metadata["isCssModule"] === true, "css module stylesheet metadata should mark isCssModule=true");

  const sourceStyling = output.patterns.find((p) => p.id === "src/Button.tsx:styling:1");
  assert(sourceStyling !== undefined, "Should emit source styling pattern for Button.tsx");
  assert(sourceStyling!.metadata["css-modules"] === true, "source styling metadata should detect css-modules");

  console.log("PASS: testStylingAnalyzerDetectsCssModules");
}

async function testStylingAnalyzerDetectsTailwindUsage() {
  const root = await freshProject({
    "src/App.tsx": `export function App() {
  return <div className="flex items-center justify-between p-4 bg-red-500 text-white">Hi</div>;
}`,
  });

  const { output } = await analyzeStylingProject(root);

  const sourceStyling = output.patterns.find((p) => p.id === "src/App.tsx:styling:1");
  assert(sourceStyling !== undefined, "Should emit styling pattern for tailwind usage");
  assert(sourceStyling!.metadata["tailwind"] === true, "tailwind usage should be detected");
  assert(
    typeof sourceStyling!.metadata["tailwindClassCount"] === "number" &&
      (sourceStyling!.metadata["tailwindClassCount"] as number) >= 3,
    "tailwindClassCount should be >= 3",
  );

  console.log("PASS: testStylingAnalyzerDetectsTailwindUsage");
}

async function testStylingAnalyzerDetectsInlineStyles() {
  const root = await freshProject({
    "src/Inline.tsx": `export function Inline() {
  const cardStyle = { color: "red", padding: 8 };
  return <div style={cardStyle}>Inline</div>;
}`,
  });

  const { output } = await analyzeStylingProject(root);

  const sourceStyling = output.patterns.find((p) => p.id === "src/Inline.tsx:styling:1");
  assert(sourceStyling !== undefined, "Should emit styling pattern for inline style usage");
  assert(sourceStyling!.metadata["inline-styles"] === true, "inline styles should be detected");
  assert(
    ((sourceStyling!.metadata["inlineStyleCount"] as number | undefined) ?? 0) >= 1 ||
      ((sourceStyling!.metadata["styleObjectCount"] as number | undefined) ?? 0) >= 1,
    "inlineStyleCount or styleObjectCount should be >= 1",
  );

  console.log("PASS: testStylingAnalyzerDetectsInlineStyles");
}

async function testStylingAnalyzerDeterministicHash() {
  const root = await freshProject({
    "src/style.css": ".a { color: red; }",
    "src/App.tsx": `export function App() {
  return <div className="flex items-center p-4">A</div>;
}`,
  });

  const files = await new FileDiscovery({ rootPath: root }).discover();
  const importAnalyzer = new ImportAnalyzer();
  const importOutput = await importAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => importAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const analyzer = new StylingAnalyzer();
  const stylingFiles = files.filter((f) => analyzer.fileFilter(f));
  const ctx = {
    rootPath: root,
    files: stylingFiles,
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([["import", importOutput]]),
  };

  const o1 = await analyzer.analyze(ctx);
  const o2 = await analyzer.analyze(ctx);
  assert(o1.hash === o2.hash, "Two runs with same input should produce identical hashes");

  console.log("PASS: testStylingAnalyzerDeterministicHash");
}

async function testStylingAnalyzerProjectProfilePattern() {
  const root = await freshProject({
    "src/global.css": ".root { color: black; }",
    "src/Button.module.css": ".button { color: blue; }",
    "src/Button.tsx": `import styles from "./Button.module.css";
export const Button = () => <button className={styles.button}>B</button>;`,
  });

  const { output } = await analyzeStylingProject(root);
  const profile = output.patterns.find((p) => p.id === ".:styling-profile:1");
  assert(profile !== undefined, "Should emit project profile pattern");
  assert(profile!.name === "styling-profile", `profile pattern name should be "styling-profile", got "${profile!.name}"`);
  assert(typeof profile!.metadata["primaryApproach"] === "string", "profile should include primaryApproach");
  assert(
    typeof profile!.metadata["technologyTally"] === "object" && profile!.metadata["technologyTally"] !== null,
    "profile should include technologyTally",
  );
  assert(
    typeof profile!.metadata["totalStyleFiles"] === "number" &&
      (profile!.metadata["totalStyleFiles"] as number) >= 2,
    "profile totalStyleFiles should be >= 2",
  );

  console.log("PASS: testStylingAnalyzerProjectProfilePattern");
}

// ---------------------------------------------------------------------------
// FileStructureAnalyzer tests
// ---------------------------------------------------------------------------

async function testFileStructureAnalyzerInterface() {
  const analyzer = new FileStructureAnalyzer();

  assert(analyzer.name === "file-structure", `name should be "file-structure", got "${analyzer.name}"`);
  assert(analyzer.version === "1.0.0", `version should be "1.0.0", got "${analyzer.version}"`);
  assert(analyzer.capabilities.includes("directory-classification"), "should have directory-classification");
  assert(analyzer.capabilities.includes("co-location-detection"), "should have co-location-detection");
  assert(analyzer.capabilities.includes("naming-convention-detection"), "should have naming-convention-detection");
  assert(analyzer.capabilities.includes("barrel-detection"), "should have barrel-detection");
  assert(analyzer.capabilities.includes("component-directory-detection"), "should have component-directory-detection");
  assert(analyzer.dependencies !== undefined && analyzer.dependencies.includes("import"), "should depend on import");

  console.log("PASS: testFileStructureAnalyzerInterface");
}

async function testFileStructureAnalyzerFileFilter() {
  const analyzer = new FileStructureAnalyzer();

  // Should accept
  assert(analyzer.fileFilter(fakeFile("src/app.ts", "ts")), ".ts should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.tsx", "tsx")), ".tsx should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.js", "js")), ".js should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.jsx", "jsx")), ".jsx should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.mjs", "mjs")), ".mjs should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.cjs", "cjs")), ".cjs should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/App.vue", "vue")), ".vue should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/App.svelte", "svelte")), ".svelte should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/style.css", "css")), ".css should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/style.scss", "scss")), ".scss should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/style.sass", "sass")), ".sass should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/style.less", "less")), ".less should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/data.json", "json")), ".json should be accepted");
  assert(analyzer.fileFilter(fakeFile("README.md", "md")), ".md should be accepted");
  assert(analyzer.fileFilter(fakeFile("docs/guide.mdx", "mdx")), ".mdx should be accepted");

  // Should reject
  assert(!analyzer.fileFilter(fakeFile("src/logo.png", "png")), ".png should be rejected");
  assert(!analyzer.fileFilter(fakeFile("src/logo.svg", "svg")), ".svg should be rejected");
  assert(!analyzer.fileFilter(fakeFile("src/font.woff", "woff")), ".woff should be rejected");

  console.log("PASS: testFileStructureAnalyzerFileFilter");
}

async function testFileStructureAnalyzerBasicOutput() {
  const analyzer = new FileStructureAnalyzer();
  const files = [
    fakeFile("src/Button.tsx", "tsx"),
    fakeFile("src/utils.ts", "ts"),
    fakeFile("src/style.css", "css"),
  ];

  const output = await analyzer.analyze({
    rootPath: "/fake",
    files,
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  assert(output.analyzerId === ("file-structure@1.0.0" as AnalyzerId), `analyzerId should be "file-structure@1.0.0", got "${output.analyzerId}"`);
  assert(typeof output.hash === "string" && (output.hash as string).length === 64, "Hash should be 64-char hex");
  assert(typeof output.duration === "number", "Duration should be a number");
  assert(output.stats.totalFiles === 3, `totalFiles should be 3, got ${output.stats.totalFiles}`);

  // Should have directory patterns for "." and "src" plus conventions pattern
  assert(output.patterns.length === 3, `Expected 3 patterns (root dir + src dir + conventions), got ${output.patterns.length}`);

  // Find the conventions pattern
  const conventions = output.patterns.find(p => p.name === "conventions");
  assert(conventions !== undefined, "Should have a conventions pattern");
  assert((conventions!.id as string) === ".:conventions:1", `conventions id should be ".:conventions:1"`);

  // Find root dir pattern
  const rootDir = output.patterns.find(p => (p.id as string) === ".:directory:1");
  assert(rootDir !== undefined, "Should have root directory pattern");
  assert(rootDir!.metadata.role === "root", "Root should have role 'root'");

  // Find src dir pattern
  const srcDir = output.patterns.find(p => (p.id as string) === "src:directory:1");
  assert(srcDir !== undefined, "Should have src directory pattern");

  // FSA001 diagnostic (no import analyzer output)
  assert(output.diagnostics.length >= 1, "Should have at least 1 diagnostic (FSA001)");
  const fsa001 = output.diagnostics.find(d => d.message.startsWith("FSA001"));
  assert(fsa001 !== undefined, "Should have FSA001 diagnostic");

  console.log("PASS: testFileStructureAnalyzerBasicOutput");
}

async function testFileStructureAnalyzerDeterminism() {
  const analyzer = new FileStructureAnalyzer();
  const files = [
    fakeFile("src/components/Button.tsx", "tsx"),
    fakeFile("src/hooks/useAuth.ts", "ts"),
    fakeFile("src/utils/format.ts", "ts"),
  ];
  const ctx = {
    rootPath: "/fake",
    files,
    cache: noopAccessor,
    previousResults: new Map() as any,
    dependencyOutputs: new Map() as any,
  };

  const o1 = await analyzer.analyze(ctx);
  const o2 = await analyzer.analyze(ctx);

  assert(o1.hash === o2.hash, "Two runs with same input should produce identical hashes");

  console.log("PASS: testFileStructureAnalyzerDeterminism");
}

async function testFileStructureAnalyzerRoleDetection() {
  const analyzer = new FileStructureAnalyzer();
  const files = [
    fakeFile("src/components/Button.tsx", "tsx"),
    fakeFile("src/hooks/useAuth.ts", "ts"),
    fakeFile("src/utils/format.ts", "ts"),
    fakeFile("src/pages/Home.tsx", "tsx"),
    fakeFile("src/styles/main.css", "css"),
  ];

  const output = await analyzer.analyze({
    rootPath: "/fake",
    files,
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const dirPatterns = output.patterns.filter(p => p.name === "directory");
  const findDir = (path: string) => dirPatterns.find(p => (p.id as string) === `${path}:directory:1`);

  const components = findDir("src/components");
  assert(components !== undefined, "src/components dir should exist");
  assert(components!.metadata.role === "components", `src/components role should be "components", got "${components!.metadata.role}"`);

  const hooks = findDir("src/hooks");
  assert(hooks !== undefined, "src/hooks dir should exist");
  assert(hooks!.metadata.role === "hooks", `src/hooks role should be "hooks", got "${hooks!.metadata.role}"`);

  const utils = findDir("src/utils");
  assert(utils !== undefined, "src/utils dir should exist");
  assert(utils!.metadata.role === "utils", `src/utils role should be "utils", got "${utils!.metadata.role}"`);

  const pages = findDir("src/pages");
  assert(pages !== undefined, "src/pages dir should exist");
  assert(pages!.metadata.role === "pages", `src/pages role should be "pages", got "${pages!.metadata.role}"`);

  const styles = findDir("src/styles");
  assert(styles !== undefined, "src/styles dir should exist");
  assert(styles!.metadata.role === "styles", `src/styles role should be "styles", got "${styles!.metadata.role}"`);

  console.log("PASS: testFileStructureAnalyzerRoleDetection");
}

async function testFileStructureAnalyzerComponentDir() {
  const analyzer = new FileStructureAnalyzer();
  const files = [
    fakeFile("src/components/Button/Button.tsx", "tsx"),
    fakeFile("src/components/Button/Button.test.tsx", "tsx"),
    fakeFile("src/components/Button/Button.module.css", "css"),
    fakeFile("src/components/Button/index.ts", "ts"),
  ];

  const output = await analyzer.analyze({
    rootPath: "/fake",
    files,
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const buttonDir = output.patterns.find(p => (p.id as string) === "src/components/Button:directory:1");
  assert(buttonDir !== undefined, "Button directory pattern should exist");
  assert(buttonDir!.metadata.isComponentDir === true, "Button dir should be detected as component directory");
  assert(buttonDir!.metadata.role === "component-directory", "role should be 'component-directory'");

  const info = buttonDir!.metadata.componentDirInfo as any;
  assert(info !== null, "componentDirInfo should not be null");
  assert(info.primaryFile === "src/components/Button/Button.tsx", `primaryFile should be Button.tsx, got "${info.primaryFile}"`);
  assert(info.indexFile === "src/components/Button/index.ts", `indexFile should be index.ts, got "${info.indexFile}"`);
  assert(info.testFiles.length === 1, "Should have 1 test file");
  assert(info.styleFiles.length === 1, "Should have 1 style file");

  // FSA003 diagnostic
  const fsa003 = output.diagnostics.find(d => d.message.startsWith("FSA003"));
  assert(fsa003 !== undefined, "Should have FSA003 diagnostic for component directory");

  console.log("PASS: testFileStructureAnalyzerComponentDir");
}

async function testFileStructureAnalyzerNamingConventions() {
  const analyzer = new FileStructureAnalyzer();
  const files = [
    fakeFile("src/MyButton.tsx", "tsx"),
    fakeFile("src/MyCard.tsx", "tsx"),
    fakeFile("src/MyInput.tsx", "tsx"),
    fakeFile("src/myHelper.ts", "ts"),
  ];

  const output = await analyzer.analyze({
    rootPath: "/fake",
    files,
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const conventions = output.patterns.find(p => p.name === "conventions");
  assert(conventions !== undefined, "Should have conventions pattern");
  assert(conventions!.metadata.dominantFileNaming === "PascalCase",
    `dominant should be PascalCase, got "${conventions!.metadata.dominantFileNaming}"`);

  console.log("PASS: testFileStructureAnalyzerNamingConventions");
}

// ---------------------------------------------------------------------------
// DependencyAnalyzer tests
// ---------------------------------------------------------------------------

async function testDependencyAnalyzerInterface() {
  const analyzer = new DependencyAnalyzer();

  assert(analyzer.name === "dependency", `name should be "dependency", got "${analyzer.name}"`);
  assert(analyzer.version === "1.0.0", `version should be "1.0.0", got "${analyzer.version}"`);
  assert(analyzer.capabilities.includes("semantic-dependency-graph"), "should have semantic-dependency-graph");
  assert(analyzer.capabilities.includes("hook-usage-tracking"), "should have hook-usage-tracking");
  assert(analyzer.capabilities.includes("cycle-detection"), "should have cycle-detection");
  assert(analyzer.dependencies !== undefined, "dependencies should exist");
  assert(analyzer.dependencies!.includes("component"), "should depend on component");
  assert(analyzer.dependencies!.includes("import"), "should depend on import");

  console.log("PASS: testDependencyAnalyzerInterface");
}

async function testDependencyAnalyzerFileFilter() {
  const analyzer = new DependencyAnalyzer();

  assert(analyzer.fileFilter(fakeFile("src/app.ts", "ts")), ".ts should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.tsx", "tsx")), ".tsx should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.jsx", "jsx")), ".jsx should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.vue", "vue")), ".vue should be accepted");
  assert(analyzer.fileFilter(fakeFile("src/app.svelte", "svelte")), ".svelte should be accepted");
  assert(!analyzer.fileFilter(fakeFile("src/style.css", "css")), ".css should be rejected");
  assert(!analyzer.fileFilter(fakeFile("src/data.json", "json")), ".json should be rejected");

  console.log("PASS: testDependencyAnalyzerFileFilter");
}

async function testDependencyAnalyzerMissingComponentAnalyzer() {
  const analyzer = new DependencyAnalyzer();
  const files = [fakeFile("src/Button.tsx", "tsx")];

  const output = await analyzer.analyze({
    rootPath: "/fake",
    files,
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  assert(output.analyzerId === ("dependency@1.0.0" as AnalyzerId), `analyzerId should be "dependency@1.0.0"`);
  // Should have graph pattern even when empty
  assert(output.patterns.length === 1, `Should have 1 pattern (graph), got ${output.patterns.length}`);
  assert((output.patterns[0]!.id as string) === ".:dependency-graph:1", "Should be graph pattern");

  // Should have DEP001 + DEP002 diagnostics
  const dep001 = output.diagnostics.find(d => d.message.startsWith("DEP001"));
  assert(dep001 !== undefined, "Should have DEP001 diagnostic");
  const dep002 = output.diagnostics.find(d => d.message.startsWith("DEP002"));
  assert(dep002 !== undefined, "Should have DEP002 diagnostic");

  // Graph metrics should be all zeros
  const graphMeta = output.patterns[0]!.metadata;
  assert(graphMeta["totalNodes"] === 0, "totalNodes should be 0");
  assert(graphMeta["totalEdges"] === 0, "totalEdges should be 0");

  console.log("PASS: testDependencyAnalyzerMissingComponentAnalyzer");
}

async function testDependencyAnalyzerRenderEdges() {
  const root = await freshProject({
    "src/Icon.tsx": "export function Icon() { return <span />; }",
    "src/Button.tsx": `import { Icon } from "./Icon";
export function Button() {
  return <div><Icon /></div>;
}`,
  });
  const files = await new FileDiscovery({ rootPath: root }).discover();

  // Run ImportAnalyzer
  const importAnalyzer = new ImportAnalyzer();
  const importOutput = await importAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => importAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  // Run ComponentAnalyzer
  const componentAnalyzer = new ComponentAnalyzer();
  const componentOutput = await componentAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => componentAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([["import", importOutput]]),
  });

  // Run DependencyAnalyzer
  const depAnalyzer = new DependencyAnalyzer();
  const depOutput = await depAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => depAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([
      ["import", importOutput],
      ["component", componentOutput],
    ]),
  });

  // Should have dependency-node patterns + graph pattern
  const graphPattern = depOutput.patterns.find(p => p.name === "dependency-graph");
  assert(graphPattern !== undefined, "Should have dependency-graph pattern");
  assert((graphPattern!.metadata["totalEdges"] as number) > 0, "Should have at least one edge");

  const renderEdges = (graphPattern!.metadata["edgesByKind"] as Record<string, number>);
  assert(renderEdges["render"] > 0, "Should have render edges");

  // Button's dep-node should reference Icon
  const buttonDep = depOutput.patterns.find(p =>
    p.name.startsWith("Button:dependencies"),
  );
  assert(buttonDep !== undefined, "Button should have a dependency-node pattern");
  assert(buttonDep!.dependencies.length > 0, "Button dep-node should have dependencies");

  const edges = buttonDep!.metadata["edges"] as any[];
  const renderEdge = edges.find((e: any) => e.kind === "render");
  assert(renderEdge !== undefined, "Button should have a render edge");
  assert(renderEdge.targetName === "Icon", `Render edge target should be Icon, got "${renderEdge.targetName}"`);

  console.log("PASS: testDependencyAnalyzerRenderEdges");
}

async function testDependencyAnalyzerHookUsageEdges() {
  const root = await freshProject({
    "src/hooks/useAuth.ts": `import { useState } from "react";
export function useAuth() {
  const [value] = useState(null);
  return value;
}`,
    "src/Dashboard.tsx": `import { useAuth } from "./hooks/useAuth";
export function Dashboard() {
  const auth = useAuth();
  return <div>{String(auth)}</div>;
}`,
  });
  const files = await new FileDiscovery({ rootPath: root }).discover();

  const importAnalyzer = new ImportAnalyzer();
  const importOutput = await importAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => importAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const componentAnalyzer = new ComponentAnalyzer();
  const componentOutput = await componentAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => componentAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([["import", importOutput]]),
  });

  const depAnalyzer = new DependencyAnalyzer();
  const depOutput = await depAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => depAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([
      ["import", importOutput],
      ["component", componentOutput],
    ]),
  });

  const graphPattern = depOutput.patterns.find(p => p.name === "dependency-graph");
  assert(graphPattern !== undefined, "Should have dependency-graph pattern");

  const edgesByKind = graphPattern!.metadata["edgesByKind"] as Record<string, number>;
  assert(edgesByKind["hook-usage"] > 0, `Should have hook-usage edges, got ${edgesByKind["hook-usage"]}`);

  // Dashboard dep-node should have hook-usage edge to useAuth
  const dashboardDep = depOutput.patterns.find(p =>
    p.name.startsWith("Dashboard:dependencies"),
  );
  assert(dashboardDep !== undefined, "Dashboard should have a dependency-node pattern");

  const edges = dashboardDep!.metadata["edges"] as any[];
  const hookEdge = edges.find((e: any) => e.kind === "hook-usage");
  assert(hookEdge !== undefined, "Dashboard should have a hook-usage edge");
  assert(hookEdge.targetName === "useAuth", `Hook edge target should be useAuth, got "${hookEdge.targetName}"`);

  console.log("PASS: testDependencyAnalyzerHookUsageEdges");
}

async function testDependencyAnalyzerDeterminism() {
  const root = await freshProject({
    "src/Icon.tsx": "export function Icon() { return <span />; }",
    "src/Button.tsx": `import { Icon } from "./Icon";
export function Button() {
  return <div><Icon /></div>;
}`,
  });
  const files = await new FileDiscovery({ rootPath: root }).discover();

  const importAnalyzer = new ImportAnalyzer();
  const importOutput = await importAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => importAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const componentAnalyzer = new ComponentAnalyzer();
  const componentOutput = await componentAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => componentAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([["import", importOutput]]),
  });

  const depAnalyzer = new DependencyAnalyzer();
  const ctx = {
    rootPath: root,
    files: files.filter((f) => depAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([
      ["import", importOutput],
      ["component", componentOutput],
    ]),
  };

  const o1 = await depAnalyzer.analyze(ctx);
  const o2 = await depAnalyzer.analyze(ctx);

  assert(o1.hash === o2.hash, "Two runs with same input should produce identical hashes");

  console.log("PASS: testDependencyAnalyzerDeterminism");
}

async function testDependencyAnalyzerGraphMetrics() {
  const root = await freshProject({
    "src/A.tsx": "export function ComponentA() { return <div />; }",
    "src/B.tsx": "export function ComponentB() { return <span />; }",
  });
  const files = await new FileDiscovery({ rootPath: root }).discover();

  const importAnalyzer = new ImportAnalyzer();
  const importOutput = await importAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => importAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map(),
  });

  const componentAnalyzer = new ComponentAnalyzer();
  const componentOutput = await componentAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => componentAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([["import", importOutput]]),
  });

  const depAnalyzer = new DependencyAnalyzer();
  const depOutput = await depAnalyzer.analyze({
    rootPath: root,
    files: files.filter((f) => depAnalyzer.fileFilter(f)),
    cache: noopAccessor,
    previousResults: new Map(),
    dependencyOutputs: new Map([
      ["import", importOutput],
      ["component", componentOutput],
    ]),
  });

  const graph = depOutput.patterns.find(p => p.name === "dependency-graph");
  assert(graph !== undefined, "Should have graph pattern");
  assert(graph!.metadata["totalNodes"] === 2, `totalNodes should be 2, got ${graph!.metadata["totalNodes"]}`);
  assert(graph!.metadata["cycleCount"] === 0, `cycleCount should be 0, got ${graph!.metadata["cycleCount"]}`);
  // Both components have no edges → 2 orphans
  assert(graph!.metadata["orphanCount"] === 2, `orphanCount should be 2, got ${graph!.metadata["orphanCount"]}`);
  // 2 isolated components → 2 connected components
  assert(graph!.metadata["componentCount"] === 2, `componentCount should be 2, got ${graph!.metadata["componentCount"]}`);

  console.log("PASS: testDependencyAnalyzerGraphMetrics");
}

// ---------------------------------------------------------------------------
// Integration: all 6 analyzers through orchestrator
// ---------------------------------------------------------------------------

async function testAllSixAnalyzersThroughOrchestrator() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() {}",
    "src/utils.ts": "export function formatDate() {}",
    "src/style.css": ".btn { color: red; }",
  });

  const discovery = new FileDiscovery({ rootPath: root });
  const files = await discovery.discover();

  const analyzers = [
    new StructureAnalyzer(),
    new ImportAnalyzer(),
    new ComponentAnalyzer(),
    new StylingAnalyzer(),
    new FileStructureAnalyzer(),
    new DependencyAnalyzer(),
  ];

  const orchestrator = new AnalyzerOrchestrator(analyzers);
  const result = await orchestrator.run({
    rootPath: root,
    files,
    cache: noopAccessor,
  });

  // All 6 should succeed
  assert(result.errors.length === 0, `Expected 0 errors, got ${result.errors.length}: ${result.errors.map(e => `${e.analyzerName}:${e.error.message}`).join(", ")}`);
  assert(result.skipped.length === 0, `Expected 0 skipped, got ${result.skipped.length}`);
  assert(result.outputs.size === 6, `Expected 6 outputs, got ${result.outputs.size}`);

  // Verify each analyzer produced output
  assert(result.outputs.has("structure"), "structure output should exist");
  assert(result.outputs.has("dependency"), "dependency output should exist");
  assert(result.outputs.has("import"), "import output should exist");
  assert(result.outputs.has("component"), "component output should exist");
  assert(result.outputs.has("styling"), "styling output should exist");
  assert(result.outputs.has("file-structure"), "file-structure output should exist");

  // structure has patterns, styling/file-structure/dependency have patterns
  assert(result.outputs.get("structure")!.patterns.length > 0, "structure should have patterns");
  assert(result.outputs.get("import")!.patterns.length === 0, "import should have 0 patterns");
  assert(result.outputs.get("component")!.patterns.length === 0, "component should have 0 patterns");
  assert(result.outputs.get("styling")!.patterns.length >= 2, "styling should have at least stylesheet + profile patterns");
  assert(
    result.outputs.get("styling")!.patterns.some((p) => (p.id as string) === ".:styling-profile:1"),
    "styling output should include project profile pattern",
  );
  assert(result.outputs.get("file-structure")!.patterns.length > 0, "file-structure should have patterns");
  // dependency should always have at least the graph pattern
  assert(result.outputs.get("dependency")!.patterns.length >= 1, "dependency should have at least graph pattern");

  console.log("PASS: testAllSixAnalyzersThroughOrchestrator");
}

async function testFullPipelineWithAllAnalyzers() {
  const root = await freshProject({
    "src/Button.tsx": "export function Button() {}",
    "src/Card.vue": "<template/>",
    "src/style.scss": ".card { padding: 1rem; }",
  });

  // Discovery
  const files = await new FileDiscovery({ rootPath: root }).discover();

  // Orchestrator
  const analyzers = [
    new StructureAnalyzer(),
    new ImportAnalyzer(),
    new ComponentAnalyzer(),
    new StylingAnalyzer(),
    new FileStructureAnalyzer(),
    new DependencyAnalyzer(),
  ];
  const result = await new AnalyzerOrchestrator(analyzers).run({
    rootPath: root,
    files,
    cache: noopAccessor,
  });

  // Normalize
  const normalized = new Map<string, import("../src/types/index.js").AnalyzerOutput>();
  for (const [name, output] of result.outputs) {
    normalized.set(name, normalizeOutput(output));
  }

  // Index
  const indexer = new IntelligenceIndexer({ rootPath: root });
  const index = await indexer.buildAndWrite(normalized);

  // Verify .uiq/ output
  const uiqFiles = await readdir(join(root, ".uiq"));
  assert(uiqFiles.includes("index.json"), "Should have index.json");
  assert(uiqFiles.includes("meta.json"), "Should have meta.json");

  // Meta should reference all 6 analyzers in compositeHash
  const meta = JSON.parse(await readFile(join(root, ".uiq/meta.json"), "utf-8"));
  assert(meta.schemaVersion === 1, "schemaVersion should be 1");
  assert(meta.buildNumber === 1, "buildNumber should be 1");

  // Production analyzers now include styling patterns in the full pipeline.
  assert(index.stats.totalPatterns >= 8, `Expected at least 8 patterns in full pipeline, got ${index.stats.totalPatterns}`);

  console.log("PASS: testFullPipelineWithAllAnalyzers");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  try {
    // ImportAnalyzer
    await testImportAnalyzerInterface();
    await testImportAnalyzerFileFilter();
    await testImportAnalyzerEmptyOutput();

    // ComponentAnalyzer
    await testComponentAnalyzerInterface();
    await testComponentAnalyzerFileFilter();
    await testComponentAnalyzerDetectsFunctionComponent();
    await testComponentAnalyzerDetectsArrowComponent();
    await testComponentAnalyzerDetectsHook();
    await testComponentAnalyzerDeterministicHash();
    await testComponentAnalyzerIntegrationWithImportAnalyzer();

    // StylingAnalyzer
    await testStylingAnalyzerInterface();
    await testStylingAnalyzerFileFilter();
    await testStylingAnalyzerDetectsCssFile();
    await testStylingAnalyzerDetectsCssModules();
    await testStylingAnalyzerDetectsTailwindUsage();
    await testStylingAnalyzerDetectsInlineStyles();
    await testStylingAnalyzerDeterministicHash();
    await testStylingAnalyzerProjectProfilePattern();

    // FileStructureAnalyzer
    await testFileStructureAnalyzerInterface();
    await testFileStructureAnalyzerFileFilter();
    await testFileStructureAnalyzerBasicOutput();
    await testFileStructureAnalyzerDeterminism();
    await testFileStructureAnalyzerRoleDetection();
    await testFileStructureAnalyzerComponentDir();
    await testFileStructureAnalyzerNamingConventions();

    // DependencyAnalyzer
    await testDependencyAnalyzerInterface();
    await testDependencyAnalyzerFileFilter();
    await testDependencyAnalyzerMissingComponentAnalyzer();
    await testDependencyAnalyzerRenderEdges();
    await testDependencyAnalyzerHookUsageEdges();
    await testDependencyAnalyzerDeterminism();
    await testDependencyAnalyzerGraphMetrics();

    // Integration
    await testAllSixAnalyzersThroughOrchestrator();
    await testFullPipelineWithAllAnalyzers();

    console.log("\nAll 34 tests passed.");
  } finally {
    await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
