// -----------------------------------------------------------------------------
// JSON-RPC 2.0 types
// -----------------------------------------------------------------------------

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

// Standard JSON-RPC error codes
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// -----------------------------------------------------------------------------
// MCP protocol types
// -----------------------------------------------------------------------------

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpCapabilities {
  readonly tools?: Record<string, never>;
  readonly resources?: Record<string, never>;
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: McpCapabilities;
  readonly serverInfo: McpServerInfo;
}

// --- Tools ---

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpToolInputSchema;
}

export interface McpToolInputSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, McpPropertySchema>>;
  readonly required?: readonly string[];
}

export interface McpPropertySchema {
  readonly type: string;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly default?: unknown;
}

export interface McpToolCallParams {
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface McpToolResult {
  readonly content: readonly McpContent[];
  readonly isError?: boolean;
}

export interface McpContent {
  readonly type: "text";
  readonly text: string;
}

// --- Resources ---

export interface McpResourceDefinition {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

export interface McpResourceReadParams {
  readonly uri: string;
}

export interface McpResourceResult {
  readonly contents: readonly McpResourceContent[];
}

export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

// --- Handler types ---

export type ToolHandler = (
  args: Readonly<Record<string, unknown>>,
) => Promise<McpToolResult>;

export type ResourceHandler = () => Promise<McpResourceResult>;

export interface RegisteredTool {
  readonly definition: McpToolDefinition;
  readonly handler: ToolHandler;
}

export interface RegisteredResource {
  readonly definition: McpResourceDefinition;
  readonly handler: ResourceHandler;
}
