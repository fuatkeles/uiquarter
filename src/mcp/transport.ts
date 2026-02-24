import { createInterface } from "node:readline";
import type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
} from "./types.js";

// -----------------------------------------------------------------------------
// StdioTransport — line-delimited JSON-RPC over stdin/stdout
// -----------------------------------------------------------------------------

export type IncomingMessage = JsonRpcRequest | JsonRpcNotification;

/**
 * Determines whether a message is a request (has `id`) or notification.
 */
export function isRequest(msg: IncomingMessage): msg is JsonRpcRequest {
  return "id" in msg && msg.id !== undefined;
}

/**
 * Minimal line-delimited JSON-RPC transport over stdio.
 *
 * Each message is a single JSON line terminated by `\n`.
 * This is the transport that Claude Code, Cursor, and other
 * MCP clients use when launching a local subprocess.
 */
export class StdioTransport {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private started = false;

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ) {
    this.input = input;
    this.output = output;
  }

  /**
   * Register the handler for incoming messages.
   */
  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Register the handler for transport close.
   */
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  /**
   * Start reading from stdin.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    const rl = createInterface({ input: this.input, terminal: false });

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      try {
        const parsed = JSON.parse(trimmed) as IncomingMessage;
        if (parsed.jsonrpc !== "2.0") return;
        this.messageHandler?.(parsed);
      } catch {
        // Malformed JSON — silently ignore per MCP spec
      }
    });

    rl.on("close", () => {
      this.closeHandler?.();
    });
  }

  /**
   * Send a JSON-RPC response.
   */
  send(response: JsonRpcResponse): void {
    const line = JSON.stringify(response) + "\n";
    this.output.write(line);
  }

  /**
   * Send a JSON-RPC notification (server → client).
   */
  notify(method: string, params?: Readonly<Record<string, unknown>>): void {
    const notification = { jsonrpc: "2.0" as const, method, params };
    const line = JSON.stringify(notification) + "\n";
    this.output.write(line);
  }
}
