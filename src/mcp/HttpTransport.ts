import * as http from "node:http";
import type {
  JsonRpcResponse,
} from "./types.js";
import { PARSE_ERROR } from "./types.js";
import type { IncomingMessage } from "./transport.js";
import { isRequest } from "./transport.js";

export class HttpTransport {
  private server: http.Server | null = null;
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private readonly port: number;
  private requestResponseMap = new Map<string | number, http.ServerResponse>();

  constructor(port: number = 3100) {
    this.port = port;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
          return;
        }

        if (req.method === "POST" && (req.url === "/rpc" || req.url === "/")) {
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const parsed = JSON.parse(body) as IncomingMessage;
              if (parsed.jsonrpc !== "2.0") {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Invalid JSON-RPC" } }));
                return;
              }

              if (isRequest(parsed)) {
                // Store response object for this request ID
                this.requestResponseMap.set(parsed.id, res);
              }

              this.messageHandler?.(parsed);

              // For notifications (no id), respond immediately
              if (!isRequest(parsed)) {
                res.writeHead(204);
                res.end();
              }
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } }));
            }
          });
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });

      this.server.on("error", reject);
      this.server.listen(this.port, () => resolve());
    });
  }

  send(response: JsonRpcResponse): void {
    const res = this.requestResponseMap.get(response.id);
    if (res) {
      this.requestResponseMap.delete(response.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    }
  }

  notify(_method: string, _params?: Readonly<Record<string, unknown>>): void {
    // HTTP transport doesn't support server-initiated notifications
    // This is a no-op (notifications are push-based, not supported over HTTP request/response)
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.closeHandler?.();
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  get address(): string {
    return `http://localhost:${this.port}`;
  }
}
