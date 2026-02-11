/** Minimal JSON-RPC over WebSocket client for Gateway communication. */

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
};

export type FileEntry = {
  name: string;
  exists: boolean;
  sizeBytes?: number;
};

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

  /** Connect to gateway and authenticate. */
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
          await this.call("connect", { token: this.token });
          this.connected = true;
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            id?: string;
            result?: unknown;
            error?: { message?: string };
          };
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) {
              p.reject(new Error(msg.error.message ?? "RPC error"));
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

      this.ws.onclose = () => {
        this.connected = false;
        // Reject all pending calls
        for (const [, p] of this.pending) {
          p.reject(new Error("Connection closed"));
        }
        this.pending.clear();
      };
    });
  }

  /** Send a JSON-RPC call and wait for response. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      const id = String(this.nextId++);
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));

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
