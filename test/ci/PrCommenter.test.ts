import { strict as assert } from "node:assert";
import { buildCommentBody, COMMENT_MARKER } from "../../src/ci/PrCommenter.js";

let passed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  PASS: ${name}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testCommentBodyFormat(): Promise<void> {
  const body = buildCommentBody("hello");
  assert.ok(body.startsWith(COMMENT_MARKER), "should start with COMMENT_MARKER");
  ok("testCommentBodyFormat");
}

async function testMarkerPresent(): Promise<void> {
  assert.ok(COMMENT_MARKER.startsWith("<!--"), "COMMENT_MARKER should be an HTML comment (starts with <!--)");
  assert.ok(COMMENT_MARKER.endsWith("-->"), "COMMENT_MARKER should end with -->");
  ok("testMarkerPresent");
}

async function testBodyContainsContent(): Promise<void> {
  const body = buildCommentBody("test body");
  assert.ok(body.includes("test body"), "should contain the provided body text");
  ok("testBodyContainsContent");
}

async function testEmptyBody(): Promise<void> {
  const body = buildCommentBody("");
  assert.ok(body.includes(COMMENT_MARKER), "should still contain marker even with empty body");
  ok("testEmptyBody");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("PrCommenter Tests");
  await testCommentBodyFormat();
  await testMarkerPresent();
  await testBodyContainsContent();
  await testEmptyBody();
  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
