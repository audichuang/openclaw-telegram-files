/** OpenClaw Gateway WebSocket client using the native frame protocol. */

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
};

export type FileEntry = {
  name: string;
  exists: boolean;
  sizeBytes?: number;
};

// Gateway protocol version (must match server)
const PROTOCOL_VERSION = 3;

export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingCall>();
  private connected = false;
  private token: string;
  private wsUrl: string;

  constructor(token: string, wsUrl: string) {
    this.token = token;
    this.wsUrl = wsUrl;
  }

  /** Connect to gateway and authenticate using the native protocol. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (err) {
        reject(new Error(`WebSocket connection failed: ${err}`));
        return;
      }

      this.ws.onopen = async () => {
        try {
          // Send connect frame with gateway protocol format
          const id = String(this.nextId++);
          const connectPromise = new Promise<void>((res, rej) => {
            this.pending.set(id, {
              resolve: () => res(),
              reject: (err) => rej(err),
            });
          });

          this.ws!.send(JSON.stringify({
            type: "req",
            id,
            method: "connect",
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: "gateway-client",
                displayName: "Telegram File Manager",
                version: "0.1.0",
                platform: "web",
                mode: "webchat",
              },
              auth: { token: this.token },
              role: "operator",
              scopes: [
                "agents.list",
                "agents.files.list",
                "agents.files.get",
                "agents.files.set",
              ],
              caps: [],
            },
          }));

          // Timeout for connect
          const timer = setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              rej(new Error("Connect timeout"));
            }
          }, 10000);

          function rej(err: Error) {
            clearTimeout(timer);
            reject(err);
          }

          await connectPromise;
          clearTimeout(timer);
          this.connected = true;
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type?: string;
            id?: string;
            ok?: boolean;
            result?: unknown;
            error?: { message?: string };
          };
          // Handle response frames
          if (msg.type === "res" && msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.ok === false || msg.error) {
              p.reject(new Error(msg.error?.message ?? "Request failed"));
            } else {
              p.resolve(msg.result);
            }
          }
        } catch {
          // ignore non-JSON frames
        }
      };

      this.ws.onerror = () => {
        if (!this.connected) {
          reject(new Error("WebSocket error"));
        }
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        const reason = event.reason || `code ${event.code}`;
        for (const [, p] of this.pending) {
          p.reject(new Error(`Connection closed: ${reason}`));
        }
        this.pending.clear();
      };
    });
  }

  /** Send a request frame and wait for response. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      const id = String(this.nextId++);
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));

      // Timeout after 15s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("RPC timeout"));
        }
      }, 15000);
    });
  }

  /** List files for an agent. */
  async listFiles(agentId: string): Promise<FileEntry[]> {
    const result = (await this.call("agents.files.list", { agentId })) as {
      files?: FileEntry[];
    };
    return result?.files ?? [];
  }

  /** Get file content. */
  async getFile(agentId: string, name: string): Promise<string> {
    const result = (await this.call("agents.files.get", { agentId, name })) as {
      content?: string;
    };
    return result?.content ?? "";
  }

  /** Set file content. */
  async setFile(agentId: string, name: string, content: string): Promise<void> {
    await this.call("agents.files.set", { agentId, name, content });
  }

  /** List agents. */
  async listAgents(): Promise<Array<{ id: string; name?: string }>> {
    const result = (await this.call("agents.list", {})) as {
      agents?: Array<{ id: string; name?: string }>;
    };
    return result?.agents ?? [];
  }

  /** Disconnect. */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
