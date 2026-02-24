import { FileDiscovery } from "../src/core/FileDiscovery.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FIXTURE_ROOT = join(tmpdir(), "uiq-test-" + Date.now());

async function setup(): Promise<void> {
  await mkdir(FIXTURE_ROOT, { recursive: true });

  // Create a realistic mini-project
  await mkdir(join(FIXTURE_ROOT, "src/components"), { recursive: true });
  await mkdir(join(FIXTURE_ROOT, "src/utils"), { recursive: true });
  await mkdir(join(FIXTURE_ROOT, "node_modules/fake-pkg"), { recursive: true });
  await mkdir(join(FIXTURE_ROOT, "dist"), { recursive: true });
  await mkdir(join(FIXTURE_ROOT, "build"), { recursive: true });
  await mkdir(join(FIXTURE_ROOT, "coverage"), { recursive: true });
  await mkdir(join(FIXTURE_ROOT, ".git/objects"), { recursive: true });

  // Source files
  await writeFile(join(FIXTURE_ROOT, "src/components/Button.tsx"), "export const Button = () => <button />;");
  await writeFile(join(FIXTURE_ROOT, "src/components/Modal.tsx"), "export const Modal = () => <div />;");
  await writeFile(join(FIXTURE_ROOT, "src/utils/format.ts"), "export const fmt = (x: string) => x.trim();");
  await writeFile(join(FIXTURE_ROOT, "src/index.ts"), "export * from './components/Button';");
  await writeFile(join(FIXTURE_ROOT, "package.json"), '{"name":"test"}');

  // Files that MUST be ignored
  await writeFile(join(FIXTURE_ROOT, "node_modules/fake-pkg/index.js"), "module.exports = {}");
  await writeFile(join(FIXTURE_ROOT, "dist/bundle.js"), "// built");
  await writeFile(join(FIXTURE_ROOT, "build/out.js"), "// built");
  await writeFile(join(FIXTURE_ROOT, "coverage/lcov.info"), "");
  await writeFile(join(FIXTURE_ROOT, ".git/objects/abc"), "blob");

  // .uiqignore with extra rule
  await writeFile(join(FIXTURE_ROOT, ".uiqignore"), "*.log\ntmp/\n");
  await mkdir(join(FIXTURE_ROOT, "tmp"), { recursive: true });
  await writeFile(join(FIXTURE_ROOT, "tmp/scratch.ts"), "// temp");
  await writeFile(join(FIXTURE_ROOT, "debug.log"), "log line");
}

async function teardown(): Promise<void> {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
}

async function run(): Promise<void> {
  await setup();

  try {
    const discovery = new FileDiscovery({ rootPath: FIXTURE_ROOT });
    const files = await discovery.discover();

    const paths = files.map((f) => f.relativePath);

    // ---- Expected files present ----
    const expected = [
      "src/components/Button.tsx",
      "src/components/Modal.tsx",
      "src/utils/format.ts",
      "src/index.ts",
      "package.json",
      ".uiqignore",
    ];
    for (const e of expected) {
      assert(paths.includes(e), `MISSING: ${e}`);
    }

    // ---- Ignored files absent ----
    const banned = [
      "node_modules/fake-pkg/index.js",
      "dist/bundle.js",
      "build/out.js",
      "coverage/lcov.info",
      ".git/objects/abc",
      "tmp/scratch.ts",
      "debug.log",
    ];
    for (const b of banned) {
      assert(!paths.includes(b), `SHOULD BE IGNORED: ${b}`);
    }

    // ---- Deterministic ordering ----
    const sorted = [...paths].sort();
    assert(
      JSON.stringify(paths) === JSON.stringify(sorted),
      `NOT SORTED: got ${JSON.stringify(paths)}`,
    );

    // ---- Stable hashes (run twice, compare) ----
    const files2 = await discovery.discover();
    for (let i = 0; i < files.length; i++) {
      assert(
        files[i]!.hash === files2[i]!.hash,
        `HASH UNSTABLE for ${files[i]!.relativePath}`,
      );
    }

    // ---- File metadata ----
    const btn = files.find((f) => f.relativePath === "src/components/Button.tsx")!;
    assert(btn.extension === "tsx", `BAD EXT: ${btn.extension}`);
    assert(btn.size > 0, `BAD SIZE: ${btn.size}`);
    assert(btn.absolutePath.endsWith("Button.tsx"), `BAD ABS PATH: ${btn.absolutePath}`);
    assert(btn.hash.length === 64, `BAD HASH LENGTH: ${btn.hash.length}`);
    assert(btn.lastModified > 0, `BAD MTIME: ${btn.lastModified}`);

    console.log(`PASS — ${files.length} files discovered, all checks passed`);
    console.log("Files:", paths);
  } finally {
    await teardown();
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
