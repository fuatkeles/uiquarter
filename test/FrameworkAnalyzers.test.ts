import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SolidAnalyzer } from "../src/analyzers/SolidAnalyzer.js";
import { LitAnalyzer } from "../src/analyzers/LitAnalyzer.js";
import { QwikAnalyzer } from "../src/analyzers/QwikAnalyzer.js";
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
  const tmp = await mkdtemp(join(tmpdir(), "uiq-fw-"));
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
// SolidAnalyzer Tests
// ===========================================================================

async function testSolidInterface(): Promise<void> {
  const analyzer = new SolidAnalyzer();
  assert.equal(analyzer.name, "solid");
  assert.equal(analyzer.version, "1.0.0");
  assert.ok(analyzer.capabilities.includes("signal-detection"));
  assert.ok(analyzer.capabilities.includes("effect-detection"));
  ok("testSolidInterface");
}

async function testSolidFileFilter(): Promise<void> {
  const analyzer = new SolidAnalyzer();
  assert.equal(analyzer.fileFilter(fakeFile("src/Counter.tsx", "tsx")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/Counter.jsx", "jsx")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/utils.ts", "ts")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/styles.css", "css")), false);
  ok("testSolidFileFilter");
}

async function testSolidDetection(): Promise<void> {
  const tmp = await createProject({
    "src/Counter.tsx": `
import { createSignal } from 'solid-js';

export function Counter() {
  const [count, setCount] = createSignal(0);
  return <div>{count()}</div>;
}
`,
  });
  try {
    const analyzer = new SolidAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/Counter.tsx", "tsx")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect Solid patterns");
    const component = output.patterns.find(p => p.type === "component");
    assert.ok(component, "should detect component");
    assert.equal(component!.name, "Counter");
    assert.equal(component!.framework, "solid");
    assert.ok(
      (component!.metadata as Record<string, unknown>).signalCount as number >= 1,
      "should count createSignal"
    );
    ok("testSolidDetection");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testSolidEmptyProject(): Promise<void> {
  const tmp = await createProject({
    "src/utils.ts": "export const x = 1;",
  });
  try {
    const analyzer = new SolidAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/utils.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.equal(output.patterns.length, 0, "should return 0 patterns for non-Solid code");
    ok("testSolidEmptyProject");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testSolidDeterministic(): Promise<void> {
  const tmp = await createProject({
    "src/Counter.tsx": `
import { createSignal } from 'solid-js';
export function Counter() {
  const [count, setCount] = createSignal(0);
  return <div>{count()}</div>;
}
`,
  });
  try {
    const analyzer = new SolidAnalyzer();
    const files = [fakeFile("src/Counter.tsx", "tsx")];
    const o1 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    const o2 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    assert.equal(o1.hash, o2.hash, "hash should be deterministic");
    ok("testSolidDeterministic");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ===========================================================================
// LitAnalyzer Tests
// ===========================================================================

async function testLitInterface(): Promise<void> {
  const analyzer = new LitAnalyzer();
  assert.equal(analyzer.name, "lit");
  assert.equal(analyzer.version, "1.0.0");
  assert.ok(analyzer.capabilities.includes("lit-element-detection"));
  assert.ok(analyzer.capabilities.includes("custom-element-detection"));
  ok("testLitInterface");
}

async function testLitFileFilter(): Promise<void> {
  const analyzer = new LitAnalyzer();
  assert.equal(analyzer.fileFilter(fakeFile("src/my-element.ts", "ts")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/my-element.js", "js")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/styles.css", "css")), false);
  ok("testLitFileFilter");
}

async function testLitDetection(): Promise<void> {
  const tmp = await createProject({
    "src/my-element.ts": `
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('my-element')
export class MyElement extends LitElement {
  @property()
  name = 'World';

  static styles = css\`
    :host { display: block; }
  \`;

  render() {
    return html\`<h1>Hello, \${this.name}!</h1>\`;
  }
}
`,
  });
  try {
    const analyzer = new LitAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/my-element.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect Lit patterns");
    const component = output.patterns.find(p => p.type === "component");
    assert.ok(component, "should detect custom element");
    assert.equal(component!.metadata.tagName, "my-element");
    assert.equal(component!.framework, "lit");
    ok("testLitDetection");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testLitEmptyProject(): Promise<void> {
  const tmp = await createProject({
    "src/utils.ts": "export const x = 1;",
  });
  try {
    const analyzer = new LitAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/utils.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.equal(output.patterns.length, 0, "should return 0 patterns for non-Lit code");
    ok("testLitEmptyProject");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testLitDeterministic(): Promise<void> {
  const tmp = await createProject({
    "src/my-element.ts": `
import { LitElement, html } from 'lit';
@customElement('my-element')
export class MyElement extends LitElement {
  render() { return html\`<p>Hello</p>\`; }
}
`,
  });
  try {
    const analyzer = new LitAnalyzer();
    const files = [fakeFile("src/my-element.ts", "ts")];
    const o1 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    const o2 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    assert.equal(o1.hash, o2.hash, "hash should be deterministic");
    ok("testLitDeterministic");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ===========================================================================
// QwikAnalyzer Tests
// ===========================================================================

async function testQwikInterface(): Promise<void> {
  const analyzer = new QwikAnalyzer();
  assert.equal(analyzer.name, "qwik");
  assert.equal(analyzer.version, "1.0.0");
  assert.ok(analyzer.capabilities.includes("component-detection"));
  assert.ok(analyzer.capabilities.includes("signal-detection"));
  ok("testQwikInterface");
}

async function testQwikFileFilter(): Promise<void> {
  const analyzer = new QwikAnalyzer();
  assert.equal(analyzer.fileFilter(fakeFile("src/Counter.tsx", "tsx")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/utils.ts", "ts")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/Counter.jsx", "jsx")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/styles.css", "css")), false);
  ok("testQwikFileFilter");
}

async function testQwikDetection(): Promise<void> {
  const tmp = await createProject({
    "src/Counter.tsx": `
import { component$, useSignal } from '@builder.io/qwik';

export const Counter = component$(() => {
  const count = useSignal(0);
  return <button onClick$={() => count.value++}>{count.value}</button>;
});
`,
  });
  try {
    const analyzer = new QwikAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/Counter.tsx", "tsx")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect Qwik patterns");
    const component = output.patterns.find(p => p.type === "component");
    assert.ok(component, "should detect component");
    assert.equal(component!.name, "Counter");
    assert.equal(component!.framework, "qwik");
    assert.equal(component!.metadata.resumable, true, "should detect resumable");
    ok("testQwikDetection");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testQwikEmptyProject(): Promise<void> {
  const tmp = await createProject({
    "src/utils.ts": "export const x = 1;",
  });
  try {
    const analyzer = new QwikAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/utils.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.equal(output.patterns.length, 0, "should return 0 patterns for non-Qwik code");
    ok("testQwikEmptyProject");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testQwikDeterministic(): Promise<void> {
  const tmp = await createProject({
    "src/Counter.tsx": `
import { component$, useSignal } from '@builder.io/qwik';
export const Counter = component$(() => {
  const count = useSignal(0);
  return <button>{count.value}</button>;
});
`,
  });
  try {
    const analyzer = new QwikAnalyzer();
    const files = [fakeFile("src/Counter.tsx", "tsx")];
    const o1 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    const o2 = await analyzer.analyze({ rootPath: tmp, files, cache: createNoopCache() });
    assert.equal(o1.hash, o2.hash, "hash should be deterministic");
    ok("testQwikDeterministic");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
  console.log("FrameworkAnalyzers Tests");

  console.log("\n  --- SolidAnalyzer ---");
  await testSolidInterface();
  await testSolidFileFilter();
  await testSolidDetection();
  await testSolidEmptyProject();
  await testSolidDeterministic();

  console.log("\n  --- LitAnalyzer ---");
  await testLitInterface();
  await testLitFileFilter();
  await testLitDetection();
  await testLitEmptyProject();
  await testLitDeterministic();

  console.log("\n  --- QwikAnalyzer ---");
  await testQwikInterface();
  await testQwikFileFilter();
  await testQwikDetection();
  await testQwikEmptyProject();
  await testQwikDeterministic();

  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
