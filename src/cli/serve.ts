import { resolve } from "node:path";
import { McpServer } from "../mcp/server.js";
import { HttpTransport } from "../mcp/HttpTransport.js";

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface ServeCommandOptions {
  readonly dir?: string;
  readonly transport?: string;   // "stdio" | "http"
  readonly port?: string;        // HTTP port (default: 3100)
}

// -----------------------------------------------------------------------------
// Command handler
// -----------------------------------------------------------------------------

/**
 * Run `uiquarter serve` — start an MCP server.
 *
 * Supports two transports:
 *   - stdio (default): line-delimited JSON-RPC over stdin/stdout
 *   - http: JSON-RPC over HTTP POST /rpc
 *
 * Configuration in AI tools:
 *   Claude Code (.claude/settings.json):
 *     { "mcpServers": { "uiquarter": { "command": "npx", "args": ["uiquarter", "serve"] } } }
 *
 *   Cursor (.cursor/mcp.json):
 *     { "mcpServers": { "uiquarter": { "command": "npx", "args": ["uiquarter", "serve"] } } }
 *
 *   HTTP mode (multi-tool):
 *     npx uiquarter serve --transport http --port 3100
 */
export async function runServeCommand(options: ServeCommandOptions): Promise<void> {
  const rootPath = resolve(options.dir ?? ".");
  const transportType = options.transport ?? "stdio";

  if (transportType === "http") {
    const port = options.port !== undefined ? Number(options.port) : 3100;
    const httpTransport = new HttpTransport(port);

    const server = new McpServer({ rootPath, transport: httpTransport });
    await server.start();
    console.log(`UIQuarter MCP server listening on http://localhost:${port}`);
    console.log(`  POST /rpc    — JSON-RPC endpoint`);
    console.log(`  GET  /health — health check`);
    // Server runs indefinitely
  } else {
    // Redirect all console output to stderr so stdout is reserved for JSON-RPC
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
    console.warn = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
    console.error = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

    try {
      const server = new McpServer({ rootPath });
      await server.start();
      // Server runs indefinitely until stdin closes
    } catch (err) {
      // Restore console for error output
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      throw err;
    }
  }
}
