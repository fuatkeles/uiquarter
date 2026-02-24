import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AngularAnalyzer } from "../src/analyzers/AngularAnalyzer.js";
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
  const tmp = await mkdtemp(join(tmpdir(), "uiq-ang-"));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testInterface(): Promise<void> {
  const analyzer = new AngularAnalyzer();
  assert.equal(analyzer.name, "angular");
  assert.equal(analyzer.version, "1.0.0");
  assert.ok(analyzer.capabilities.length > 0, "should have capabilities");
  assert.ok(analyzer.capabilities.includes("component-detection"), "should include component-detection");
  assert.ok(analyzer.capabilities.includes("service-detection"), "should include service-detection");
  assert.ok(analyzer.capabilities.includes("module-detection"), "should include module-detection");
  assert.ok(analyzer.capabilities.includes("route-detection"), "should include route-detection");
  assert.ok(analyzer.capabilities.includes("standalone-detection"), "should include standalone-detection");
  ok("testInterface");
}

async function testFileFilter(): Promise<void> {
  const analyzer = new AngularAnalyzer();
  assert.equal(analyzer.fileFilter(fakeFile("src/app.component.ts", "ts")), true);
  assert.equal(analyzer.fileFilter(fakeFile("src/app.spec.ts", "ts")), false);
  assert.equal(analyzer.fileFilter(fakeFile("src/app.js", "js")), false);
  assert.equal(analyzer.fileFilter(fakeFile("src/types.d.ts", "ts")), false);
  assert.equal(analyzer.fileFilter(fakeFile("src/app.test.ts", "ts")), false);
  ok("testFileFilter");
}

async function testNonAngularReturnsEmpty(): Promise<void> {
  const tmp = await createProject({
    "src/plain.ts": "export function hello() { return 'world'; }",
  });
  try {
    const analyzer = new AngularAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/plain.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.equal(output.patterns.length, 0, "should return 0 patterns for non-Angular");
    ok("testNonAngularReturnsEmpty");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testComponentDetection(): Promise<void> {
  const tmp = await createProject({
    "src/app.component.ts": `
import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  template: '<div>Hello</div>'
})
export class AppComponent {}
`,
  });
  try {
    const analyzer = new AngularAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/app.component.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect patterns");
    const component = output.patterns.find(p => p.type === "component");
    assert.ok(component, "should detect a component");
    assert.equal(component!.name, "app-root");
    assert.equal(component!.framework, "angular");
    assert.equal(component!.metadata.standalone, true);
    ok("testComponentDetection");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testServiceDetection(): Promise<void> {
  const tmp = await createProject({
    "src/auth.service.ts": `
import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  isLoggedIn() { return false; }
}
`,
  });
  try {
    const analyzer = new AngularAnalyzer();
    // Need at least one component or module to trigger Angular detection
    // Actually the analyzer checks: hasAngular = allMetrics.some(m => m.components.length > 0 || m.modules.length > 0)
    // So a service-only project won't produce output. Let's add a component too.
    const tmp2 = await createProject({
      "src/auth.service.ts": `
import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  isLoggedIn() { return false; }
`,
      "src/app.component.ts": `
@Component({
  selector: 'app-root',
  template: '<div>Hello</div>'
})
export class AppComponent {}
`,
    });
    try {
      const analyzer2 = new AngularAnalyzer();
      const output = await analyzer2.analyze({
        rootPath: tmp2,
        files: [
          fakeFile("src/auth.service.ts", "ts"),
          fakeFile("src/app.component.ts", "ts"),
        ],
        cache: createNoopCache(),
      });
      const service = output.patterns.find(p => p.metadata.providedIn === "root");
      assert.ok(service, "should detect service with providedIn");
      ok("testServiceDetection");
    } finally {
      await rm(tmp2, { recursive: true, force: true });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testModuleDetection(): Promise<void> {
  const tmp = await createProject({
    "src/app.module.ts": `
import { NgModule } from '@angular/core';

@NgModule({
  declarations: [AppComponent],
  imports: [BrowserModule],
  exports: []
})
export class AppModule {}
`,
  });
  try {
    const analyzer = new AngularAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/app.module.ts", "ts")],
      cache: createNoopCache(),
    });
    assert.ok(output.patterns.length > 0, "should detect module patterns");
    const summary = output.patterns.find(p => p.name === "angular-summary");
    assert.ok(summary, "should have summary pattern");
    assert.ok(
      (summary!.metadata as Record<string, unknown>).totalModules as number >= 1,
      "should count at least 1 module"
    );
    ok("testModuleDetection");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testDirectiveAndPipe(): Promise<void> {
  const tmp = await createProject({
    "src/highlight.directive.ts": `
@Directive({
  selector: '[appHighlight]'
})
export class HighlightDirective {}

@Pipe({
  name: 'capitalize'
})
export class CapitalizePipe {}
`,
    "src/app.component.ts": `
@Component({
  selector: 'app-root',
  template: '<div>Hello</div>'
})
export class AppComponent {}
`,
  });
  try {
    const analyzer = new AngularAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [
        fakeFile("src/highlight.directive.ts", "ts"),
        fakeFile("src/app.component.ts", "ts"),
      ],
      cache: createNoopCache(),
    });
    const directive = output.patterns.find(p => p.type === "directive");
    assert.ok(directive, "should detect directive");
    const pipe = output.patterns.find(p => p.metadata.pipeCount !== undefined);
    assert.ok(pipe, "should detect pipe");
    ok("testDirectiveAndPipe");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testRouteDetection(): Promise<void> {
  const tmp = await createProject({
    "src/app-routing.module.ts": `
import { RouterModule } from '@angular/router';

@NgModule({
  imports: [
    RouterModule.forRoot([
      { path: 'home', component: HomeComponent },
      { path: 'about', component: AboutComponent }
    ])
  ]
})
export class AppRoutingModule {}
`,
  });
  try {
    const analyzer = new AngularAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/app-routing.module.ts", "ts")],
      cache: createNoopCache(),
    });
    const summary = output.patterns.find(p => p.name === "angular-summary");
    assert.ok(summary, "should have summary");
    assert.ok(
      (summary!.metadata as Record<string, unknown>).totalRoutes as number >= 2,
      "should detect at least 2 routes"
    );
    ok("testRouteDetection");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testStandaloneComponents(): Promise<void> {
  const tmp = await createProject({
    "src/standalone.component.ts": `
@Component({
  selector: 'app-standalone',
  standalone: true,
  template: '<p>standalone</p>'
})
export class StandaloneComponent {}
`,
  });
  try {
    const analyzer = new AngularAnalyzer();
    const output = await analyzer.analyze({
      rootPath: tmp,
      files: [fakeFile("src/standalone.component.ts", "ts")],
      cache: createNoopCache(),
    });
    const comp = output.patterns.find(p => p.type === "component");
    assert.ok(comp, "should detect component");
    assert.equal(comp!.metadata.standalone, true, "should detect standalone: true");
    const summary = output.patterns.find(p => p.name === "angular-summary");
    assert.ok(summary, "should have summary");
    assert.ok(
      (summary!.metadata as Record<string, unknown>).standaloneCount as number >= 1,
      "should count standalone"
    );
    ok("testStandaloneComponents");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testDeterministicHash(): Promise<void> {
  const tmp = await createProject({
    "src/app.component.ts": `
@Component({
  selector: 'app-root',
  standalone: true,
  template: '<div>Hello</div>'
})
export class AppComponent {}
`,
  });
  try {
    const analyzer = new AngularAnalyzer();
    const files = [fakeFile("src/app.component.ts", "ts")];
    const output1 = await analyzer.analyze({
      rootPath: tmp,
      files,
      cache: createNoopCache(),
    });
    const output2 = await analyzer.analyze({
      rootPath: tmp,
      files,
      cache: createNoopCache(),
    });
    assert.equal(output1.hash, output2.hash, "hash should be deterministic");
    ok("testDeterministicHash");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("AngularAnalyzer Tests");
  await testInterface();
  await testFileFilter();
  await testNonAngularReturnsEmpty();
  await testComponentDetection();
  await testServiceDetection();
  await testModuleDetection();
  await testDirectiveAndPipe();
  await testRouteDetection();
  await testStandaloneComponents();
  await testDeterministicHash();
  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
