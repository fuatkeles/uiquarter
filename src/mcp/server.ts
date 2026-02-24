import { QueryEngine } from "../query/QueryEngine.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { createHandlers } from "./handlers.js";
import { StdioTransport, isRequest } from "./transport.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpInitializeResult,
  McpToolCallParams,
  McpResourceReadParams,
  RegisteredTool,
  RegisteredResource,
} from "./types.js";
import {
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} from "./types.js";
import type { IncomingMessage } from "./transport.js";

// -----------------------------------------------------------------------------
// Transport interface — shared between stdio and HTTP
// -----------------------------------------------------------------------------

export interface Transport {
  onMessage(handler: (msg: IncomingMessage) => void): void;
  onClose(handler: () => void): void;
  start(): void | Promise<void>;
  send(response: JsonRpcResponse): void;
  notify(method: string, params?: Readonly<Record<string, unknown>>): void;
}

// -----------------------------------------------------------------------------
// MCP Server
// -----------------------------------------------------------------------------

export interface McpServerOptions {
  /** Absolute path to the project root */
  readonly rootPath: string;

  /** Optional stdio streams (for testing) */
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;

  /** Optional custom transport (overrides stdio) */
  readonly transport?: Transport;
}

/**
 * UIQuarter MCP Server.
 *
 * Implements the Model Context Protocol over stdio, exposing
 * the UIQuarter intelligence index as tools and resources that
 * AI coding assistants (Claude Code, Cursor, Copilot) can query.
 *
 * This is the primary token-saving mechanism: instead of loading
 * a full CLAUDE.md (~5K tokens), the AI queries only what it needs
 * via `uiq_scope_context` or `uiq_query_component` (~200-500 tokens).
 *
 * Protocol flow:
 *   1. Client sends `initialize` → server responds with capabilities
 *   2. Client sends `initialized` notification
 *   3. Client calls tools via `tools/call` or reads resources via `resources/read`
 */
export class McpServer {
  private readonly rootPath: string;
  private readonly transport: Transport;
  private tools: readonly RegisteredTool[] = [];
  private resources: readonly RegisteredResource[] = [];
  // Protocol state tracked for potential future use (e.g., rejecting pre-init calls)
  public initialized = false;

  constructor(options: McpServerOptions) {
    this.rootPath = options.rootPath;
    this.transport = options.transport ?? new StdioTransport(options.input, options.output);
  }

  /**
   * Start the MCP server.
   *
   * Loads the intelligence index, registers handlers, and begins
   * listening for JSON-RPC messages on stdin.
   */
  async start(): Promise<void> {
    // Load the intelligence index
    const engine = new QueryEngine(this.rootPath);
    await engine.load();

    const contextBuilder = new ContextBuilder(this.rootPath);
    await contextBuilder.load();

    // Register handlers
    const handlers = createHandlers(engine, contextBuilder);
    this.tools = handlers.tools;
    this.resources = handlers.resources;

    // Wire transport
    this.transport.onMessage((msg) => {
      if (isRequest(msg)) {
        this.handleRequest(msg).then(
          (response) => this.transport.send(response),
          (err) => {
            this.transport.send({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: INTERNAL_ERROR,
                message: err instanceof Error ? err.message : String(err),
              },
            });
          },
        );
      }
      // Notifications (like "initialized") are handled silently
      if (!isRequest(msg) && msg.method === "initialized") {
        this.initialized = true;
      }
    });

    this.transport.onClose(() => {
      process.exit(0);
    });

    this.transport.start();
  }

  // ---------------------------------------------------------------------------
  // Request dispatcher
  // ---------------------------------------------------------------------------

  private async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id;

    switch (req.method) {
      case "initialize":
        return this.handleInitialize(id);

      case "tools/list":
        return this.handleToolsList(id);

      case "tools/call":
        return this.handleToolsCall(id, req.params as unknown as McpToolCallParams);

      case "resources/list":
        return this.handleResourcesList(id);

      case "resources/read":
        return this.handleResourcesRead(id, req.params as unknown as McpResourceReadParams);

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: METHOD_NOT_FOUND,
            message: `Unknown method: ${req.method}`,
          },
        };
    }
  }

  // ---------------------------------------------------------------------------
  // Protocol handlers
  // ---------------------------------------------------------------------------

  private handleInitialize(id: string | number): JsonRpcResponse {
    const result: McpInitializeResult = {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
        resources: {},
      },
      serverInfo: {
        name: "uiquarter",
        version: "0.1.0",
      },
    };

    return { jsonrpc: "2.0", id, result };
  }

  private handleToolsList(id: string | number): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: this.tools.map((t) => t.definition),
      },
    };
  }

  private async handleToolsCall(
    id: string | number,
    params: McpToolCallParams,
  ): Promise<JsonRpcResponse> {
    if (!params || typeof params.name !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: INVALID_PARAMS,
          message: "Missing tool name",
        },
      };
    }

    const tool = this.tools.find((t) => t.definition.name === params.name);
    if (!tool) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: METHOD_NOT_FOUND,
          message: `Unknown tool: ${params.name}`,
        },
      };
    }

    try {
      const result = await tool.handler(params.arguments ?? {});
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{
            type: "text",
            text: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        },
      };
    }
  }

  private handleResourcesList(id: string | number): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        resources: this.resources.map((r) => r.definition),
      },
    };
  }

  private async handleResourcesRead(
    id: string | number,
    params: McpResourceReadParams,
  ): Promise<JsonRpcResponse> {
    if (!params || typeof params.uri !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: INVALID_PARAMS,
          message: "Missing resource URI",
        },
      };
    }

    const resource = this.resources.find((r) => r.definition.uri === params.uri);
    if (!resource) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: METHOD_NOT_FOUND,
          message: `Unknown resource: ${params.uri}`,
        },
      };
    }

    try {
      const result = await resource.handler();
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: INTERNAL_ERROR,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
