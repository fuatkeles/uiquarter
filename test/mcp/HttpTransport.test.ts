import { strict as assert } from "node:assert";
import * as http from "node:http";
import { HttpTransport } from "../../src/mcp/HttpTransport.js";

let passed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  PASS: ${name}`);
}

function httpRequest(options: {
  port: number;
  method: string;
  path: string;
  body?: string;
}): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.body ? { "Content-Type": "application/json" } : {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body,
            headers: res.headers as Record<string, string>,
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function getRandomPort(): number {
  return 39000 + Math.floor(Math.random() * 1000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testStartAndStop(): Promise<void> {
  const port = getRandomPort();
  const transport = new HttpTransport(port);
  transport.onMessage(() => {});
  transport.onClose(() => {});
  await transport.start();
  assert.ok(transport.listening, "should be listening after start");
  await transport.stop();
  assert.ok(!transport.listening, "should not be listening after stop");
  ok("testStartAndStop");
}

async function testHealthEndpoint(): Promise<void> {
  const port = getRandomPort();
  const transport = new HttpTransport(port);
  transport.onMessage(() => {});
  transport.onClose(() => {});
  await transport.start();
  try {
    const res = await httpRequest({ port, method: "GET", path: "/health" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, "ok");
  } finally {
    await transport.stop();
  }
  ok("testHealthEndpoint");
}

async function testRpcEndpoint(): Promise<void> {
  const port = getRandomPort();
  const transport = new HttpTransport(port);
  transport.onMessage((msg) => {
    if ("id" in msg && msg.id !== undefined) {
      transport.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: "2024-11-05" },
      });
    }
  });
  transport.onClose(() => {});
  await transport.start();
  try {
    const res = await httpRequest({
      port,
      method: "POST",
      path: "/rpc",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.result.protocolVersion, "2024-11-05");
    assert.equal(body.id, 1);
  } finally {
    await transport.stop();
  }
  ok("testRpcEndpoint");
}

async function testCorsHeaders(): Promise<void> {
  const port = getRandomPort();
  const transport = new HttpTransport(port);
  transport.onMessage(() => {});
  transport.onClose(() => {});
  await transport.start();
  try {
    const res = await httpRequest({ port, method: "OPTIONS", path: "/rpc" });
    assert.equal(res.statusCode, 204);
    assert.ok(
      res.headers["access-control-allow-origin"] === "*",
      "should have CORS Allow-Origin header"
    );
    assert.ok(
      res.headers["access-control-allow-methods"] !== undefined,
      "should have CORS Allow-Methods header"
    );
  } finally {
    await transport.stop();
  }
  ok("testCorsHeaders");
}

async function testInvalidJson(): Promise<void> {
  const port = getRandomPort();
  const transport = new HttpTransport(port);
  transport.onMessage(() => {});
  transport.onClose(() => {});
  await transport.start();
  try {
    const res = await httpRequest({
      port,
      method: "POST",
      path: "/rpc",
      body: "not json at all",
    });
    assert.equal(res.statusCode, 400, "should return 400 for invalid JSON");
    const body = JSON.parse(res.body);
    assert.ok(body.error !== undefined, "should have error field");
    assert.equal(body.error.code, -32700, "should be parse error code");
  } finally {
    await transport.stop();
  }
  ok("testInvalidJson");
}

async function testNotFound(): Promise<void> {
  const port = getRandomPort();
  const transport = new HttpTransport(port);
  transport.onMessage(() => {});
  transport.onClose(() => {});
  await transport.start();
  try {
    const res = await httpRequest({ port, method: "GET", path: "/unknown" });
    assert.equal(res.statusCode, 404, "should return 404 for unknown path");
  } finally {
    await transport.stop();
  }
  ok("testNotFound");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("HttpTransport Tests");
  await testStartAndStop();
  await testHealthEndpoint();
  await testRpcEndpoint();
  await testCorsHeaders();
  await testInvalidJson();
  await testNotFound();
  console.log(`\n${passed} tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
