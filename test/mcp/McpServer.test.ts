import { strict as assert } from "node:assert";
import { Readable, Writable } from "node:stream";
import { resolve, join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { JsonRpcResponse } from "../../src/mcp/types.js";
import { StdioTransport, isRequest } from "../../src/mcp/transport.js";
import { McpServer } from "../../src/mcp/server.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let passed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  PASS: ${name}`);
}

/** Create a minimal project and run init on it */
async function createTestProject(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "uiq-mcp-"));
  await mkdir(join(tmp, "src"), { recursive: true });

  await writeFile(
    join(tmp, "src", "Button.tsx"),
    `export function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}\n`,
  );

  await writeFile(
    join(tmp, "src", "App.tsx"),
    `import { Button } from './Button';\nexport function App() {\n  return <Button label="Click" />;\n}\n`,
  );

  // Run init
  const cliPath = resolve("dist/cli.js");
  execSync(`node "${cliPath}" init -d "${tmp}"`, { stdio: "ignore" });

  return tmp;
}

/** Send a JSON-RPC request via a writable stream and collect the response */
function createMockStreams(): {
  input: Readable;
  output: Writable;
  responses: string[];
  send: (msg: Record<string, unknown>) => void;
} {
  const responses: string[] = [];
  const input = new Readable({ read() {} });
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const line = chunk.toString().trim();
      if (line.length > 0) {
        responses.push(line);
      }
      callback();
    },
  });

  const send = (msg: Record<string, unknown>): void => {
    input.push(JSON.stringify(msg) + "\n");
  };

  return { input, output, responses, send };
}

function parseResponse(raw: string): JsonRpcResponse {
  return JSON.parse(raw) as JsonRpcResponse;
}

// Wait for responses to appear
function waitForResponse(responses: string[], expectedCount: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (responses.length >= expectedCount) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for ${expectedCount} responses, got ${responses.length}`));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

// -----------------------------------------------------------------------------
// Transport tests
// -----------------------------------------------------------------------------

async function testTransportSendReceive(): Promise<void> {
  const { input, output, responses, send } = createMockStreams();
  const transport = new StdioTransport(input, output);

  const received: unknown[] = [];
  transport.onMessage((msg) => received.push(msg));
  transport.start();

  // Send a request
  send({ jsonrpc: "2.0", id: 1, method: "test" });

  // Wait briefly for readline to process
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(received.length, 1);
  const msg = received[0] as { jsonrpc: string; id: number; method: string };
  assert.equal(msg.method, "test");
  assert.equal(msg.id, 1);

  // Test sending a response
  transport.send({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.equal(responses.length, 1);
  const resp = parseResponse(responses[0]!);
  assert.equal(resp.id, 1);
  assert.deepEqual(resp.result, { ok: true });

  ok("testTransportSendReceive");
}

async function testTransportIsRequest(): Promise<void> {
  assert.equal(isRequest({ jsonrpc: "2.0" as const, id: 1, method: "test" }), true);
  assert.equal(isRequest({ jsonrpc: "2.0" as const, method: "notify" }), false);
  ok("testTransportIsRequest");
}

async function testTransportIgnoresMalformed(): Promise<void> {
  const { input, output } = createMockStreams();
  const transport = new StdioTransport(input, output);

  const received: unknown[] = [];
  transport.onMessage((msg) => received.push(msg));
  transport.start();

  // Push malformed JSON
  input.push("not json\n");
  input.push("{}\n"); // missing jsonrpc
  input.push('{"jsonrpc":"1.0","id":1,"method":"test"}\n'); // wrong version

  await new Promise((r) => setTimeout(r, 100));

  // None should be received (all malformed or wrong version)
  assert.equal(received.length, 0);
  ok("testTransportIgnoresMalformed");
}

// -----------------------------------------------------------------------------
// MCP Server integration tests
// -----------------------------------------------------------------------------

async function testMcpInitialize(): Promise<void> {
  const projectDir = await createTestProject();

  try {
    const { input, output, responses, send } = createMockStreams();
    const server = new McpServer({
      rootPath: projectDir,
      input,
      output,
    });

    await server.start();

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitForResponse(responses, 1);

    const resp = parseResponse(responses[0]!);
    assert.equal(resp.id, 1);
    assert.equal(resp.error, undefined);

    const result = resp.result as { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } };
    assert.equal(result.protocolVersion, "2024-11-05");
    assert.equal(result.serverInfo.name, "uiquarter");

    ok("testMcpInitialize");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function testMcpToolsList(): Promise<void> {
  const projectDir = await createTestProject();

  try {
    const { input, output, responses, send } = createMockStreams();
    const server = new McpServer({ rootPath: projectDir, input, output });
    await server.start();

    send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    await waitForResponse(responses, 1);

    const resp = parseResponse(responses[0]!);
    const result = resp.result as { tools: readonly { name: string }[] };

    assert.ok(Array.isArray(result.tools));
    assert.ok(result.tools.length >= 7, `Expected at least 7 tools, got ${result.tools.length}`);

    const toolNames = result.tools.map((t) => t.name);
    assert.ok(toolNames.includes("uiq_query_component"));
    assert.ok(toolNames.includes("uiq_resolve_task"));
    assert.ok(toolNames.includes("uiq_scope_context"));
    assert.ok(toolNames.includes("uiq_get_insights"));
    assert.ok(toolNames.includes("uiq_get_stats"));
    assert.ok(toolNames.includes("uiq_find_dependencies"));
    assert.ok(toolNames.includes("uiq_find_dependents"));

    ok("testMcpToolsList");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function testMcpResourcesList(): Promise<void> {
  const projectDir = await createTestProject();

  try {
    const { input, output, responses, send } = createMockStreams();
    const server = new McpServer({ rootPath: projectDir, input, output });
    await server.start();

    send({ jsonrpc: "2.0", id: 1, method: "resources/list", params: {} });
    await waitForResponse(responses, 1);

    const resp = parseResponse(responses[0]!);
    const result = resp.result as { resources: readonly { uri: string }[] };

    assert.ok(Array.isArray(result.resources));
    assert.ok(result.resources.length >= 3);

    const uris = result.resources.map((r) => r.uri);
    assert.ok(uris.includes("uiq://stats"));
    assert.ok(uris.includes("uiq://components"));
    assert.ok(uris.includes("uiq://insights"));

    ok("testMcpResourcesList");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function testMcpGetStats(): Promise<void> {
  const projectDir = await createTestProject();

  try {
    const { input, output, responses, send } = createMockStreams();
    const server = new McpServer({ rootPath: projectDir, input, output });
    await server.start();

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "uiq_get_stats", arguments: {} },
    });
    await waitForResponse(responses, 1);

    const resp = parseResponse(responses[0]!);
    assert.equal(resp.error, undefined);

    const result = resp.result as { content: readonly { type: string; text: string }[] };
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]!.type, "text");

    const parsed = JSON.parse(result.content[0]!.text) as Record<string, number>;
    assert.ok(typeof parsed["totalPatterns"] === "number");
    assert.ok(typeof parsed["totalComponents"] === "number");

    ok("testMcpGetStats");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function testMcpQueryComponent(): Promise<void> {
  const projectDir = await createTestProject();

  try {
    const { input, output, responses, send } = createMockStreams();
    const server = new McpServer({ rootPath: projectDir, input, output });
    await server.start();

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "uiq_query_component", arguments: { name: "Button" } },
    });
    await waitForResponse(responses, 1);

    const resp = parseResponse(responses[0]!);
    assert.equal(resp.error, undefined);

    const result = resp.result as { content: readonly { text: string }[] };
    const text = result.content[0]!.text;

    // Should be JSON with component info
    const parsed = JSON.parse(text) as { name: string; type: string };
    assert.equal(parsed.name, "Button");
    assert.equal(parsed.type, "component");

    ok("testMcpQueryComponent");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function testMcpQueryComponentNotFound(): Promise<void> {
  const projectDir = await createTestProject();

  try {
    const { input, output, responses, send } = createMockStreams();
    const server = new McpServer({ rootPath: projectDir, input, output });
    await server.start();

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "uiq_query_component", arguments: { name: "NonExistent" } },
    });
    await waitForResponse(responses, 1);

    const resp = parseResponse(responses[0]!);
    const result = resp.result as { content: readonly { text: string }[] };
    assert.ok(result.content[0]!.text.includes("No component found"));

    ok("testMcpQueryComponentNotFound");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function testMcpScopeContext(): Promise<void> {
  const projectDir = await createTestProject();

  try {
    const { input, output, responses, send } = createMockStreams();
    const server = new McpServer({ rootPath: projectDir, input, output });
    await server.start();

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "uiq_scope_context", arguments: { task: "refactor Button", format: "text" } },
    });
    await waitForResponse(responses, 1);

    const resp = parseResponse(responses[0]!);
    assert.equal(resp.error, undefined);

    const result = resp.result as { content: readonly { text: string }[] };
    assert.ok(result.content[0]!.text.length > 0);

    ok("testMcpScopeContext");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function testMcpUnknownMethod(): Promise<void> {
  const projectDir = await createTestProject();

  try {
    const { input, output, responses, send } = createMockStreams();
    const server = new McpServer({ rootPath: projectDir, input, output });
    await server.start();

    send({ jsonrpc: "2.0", id: 1, method: "unknown/method", params: {} });
    await waitForResponse(responses, 1);

    const resp = parseResponse(responses[0]!);
    assert.ok(resp.error !== undefined);
    assert.equal(resp.error!.code, -32601); // METHOD_NOT_FOUND

    ok("testMcpUnknownMethod");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function testMcpResourceRead(): Promise<void> {
  const projectDir = await createTestProject();

  try {
    const { input, output, responses, send } = createMockStreams();
    const server = new McpServer({ rootPath: projectDir, input, output });
    await server.start();

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "uiq://stats" },
    });
    await waitForResponse(responses, 1);

    const resp = parseResponse(responses[0]!);
    assert.equal(resp.error, undefined);

    const result = resp.result as { contents: readonly { uri: string; text: string }[] };
    assert.ok(result.contents.length > 0);
    assert.equal(result.contents[0]!.uri, "uiq://stats");

    const stats = JSON.parse(result.contents[0]!.text) as Record<string, number>;
    assert.ok(typeof stats["totalPatterns"] === "number");

    ok("testMcpResourceRead");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function testMcpPing(): Promise<void> {
  const projectDir = await createTestProject();

  try {
    const { input, output, responses, send } = createMockStreams();
    const server = new McpServer({ rootPath: projectDir, input, output });
    await server.start();

    send({ jsonrpc: "2.0", id: 42, method: "ping", params: {} });
    await waitForResponse(responses, 1);

    const resp = parseResponse(responses[0]!);
    assert.equal(resp.id, 42);
    assert.deepEqual(resp.result, {});

    ok("testMcpPing");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function testMcpGetInsights(): Promise<void> {
  const projectDir = await createTestProject();

  try {
    const { input, output, responses, send } = createMockStreams();
    const server = new McpServer({ rootPath: projectDir, input, output });
    await server.start();

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "uiq_get_insights", arguments: {} },
    });
    await waitForResponse(responses, 1);

    const resp = parseResponse(responses[0]!);
    assert.equal(resp.error, undefined);

    // Should return some result (may be empty or populated depending on project)
    const result = resp.result as { content: readonly { text: string }[] };
    assert.ok(result.content.length > 0);

    ok("testMcpGetInsights");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("MCP Server tests");

  // Transport unit tests
  await testTransportSendReceive();
  await testTransportIsRequest();
  await testTransportIgnoresMalformed();

  // Integration tests (sequentially — they share the project creation)
  await testMcpInitialize();
  await testMcpToolsList();
  await testMcpResourcesList();
  await testMcpGetStats();
  await testMcpQueryComponent();
  await testMcpQueryComponentNotFound();
  await testMcpScopeContext();
  await testMcpUnknownMethod();
  await testMcpResourceRead();
  await testMcpPing();
  await testMcpGetInsights();

  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
