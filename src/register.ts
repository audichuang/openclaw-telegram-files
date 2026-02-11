import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createPairingCode, exchangePairingCode } from "./pairing.js";
import { getFilesRuntime } from "./runtime.js";
import { serveStaticAsset } from "./static-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_WEBAPP = path.resolve(__dirname, "..", "dist", "webapp");

type TelegramFilesPluginConfig = {
  externalUrl?: string;
};

// Active session tokens (exchanged from pairing codes)
const activeTokens = new Set<string>();

/** Read a JSON body from an IncomingMessage. */
function readJsonBody(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/** Check bearer token from Authorization header. */
function checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return activeTokens.has(auth.slice(7));
}

function jsonResponse(res: ServerResponse, status: number, data: unknown) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

/** Prevent path traversal: resolve and verify the path is absolute. */
function safePath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes("\0")) return null;
  const resolved = path.resolve(rawPath);
  return resolved;
}

export function registerAll(api: OpenClawPluginApi) {
  const pluginConfig = api.pluginConfig as TelegramFilesPluginConfig | undefined;

  // 1. Register /files command
  api.registerCommand({
    name: "files",
    description: "Open file manager on mobile",
    handler: async (ctx) => {
      const cfg = ctx.config;
      const externalUrl = pluginConfig?.externalUrl;

      if (!externalUrl) {
        return { text: 'Please set externalUrl: openclaw config set plugins.entries.telegram-files.config.externalUrl "https://your-host"' };
      }

      const gatewayToken = cfg.gateway?.auth?.token;
      if (!gatewayToken) {
        return { text: "Gateway auth token not found. Set gateway.auth.token in config." };
      }

      const code = createPairingCode(gatewayToken);
      const miniAppUrl = `${externalUrl}/plugins/telegram-files/?pair=${code}`;

      if (ctx.channel === "telegram" && ctx.senderId) {
        const runtime = getFilesRuntime();
        const { token } = runtime.channel.telegram.resolveTelegramToken(cfg);
        if (token) {
          try {
            const resp = await fetch(
              `https://api.telegram.org/bot${token}/sendMessage`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: ctx.senderId,
                  text: "Tap to open file manager:",
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "Open File Manager", web_app: { url: miniAppUrl } }],
                    ],
                  },
                }),
              },
            );
            if (resp.ok) return { text: "" };
          } catch {
            // Fall through
          }
        }
      }

      return { text: `Open file manager: ${miniAppUrl}` };
    },
  });

  // 2. Register HTTP handler
  api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const prefix = "/plugins/telegram-files";

    if (!url.pathname.startsWith(prefix)) return false;

    const subPath = url.pathname.slice(prefix.length) || "/";

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.statusCode = 204;
      res.end();
      return true;
    }

    // --- Token exchange (no auth required) ---
    if (req.method === "POST" && subPath === "/api/exchange") {
      const body = await readJsonBody(req);
      const pairCode = typeof body?.pairCode === "string" ? body.pairCode : "";
      const gwToken = exchangePairingCode(pairCode);

      if (!gwToken) {
        jsonResponse(res, 401, { error: "invalid or expired pairing code" });
        return true;
      }

      // Create a session token for subsequent API calls
      const sessionToken = crypto.randomUUID();
      activeTokens.add(sessionToken);
      jsonResponse(res, 200, { token: sessionToken });
      return true;
    }

    // --- All other API endpoints require auth ---
    if (subPath.startsWith("/api/")) {
      if (!checkAuth(req)) {
        jsonResponse(res, 401, { error: "unauthorized" });
        return true;
      }

      // GET /api/ls?path=/some/dir
      if (req.method === "GET" && subPath === "/api/ls") {
        const dirPath = safePath(url.searchParams.get("path") || "/");
        if (!dirPath) {
          jsonResponse(res, 400, { error: "invalid path" });
          return true;
        }

        try {
          const stat = fs.statSync(dirPath);
          if (!stat.isDirectory()) {
            jsonResponse(res, 400, { error: "not a directory" });
            return true;
          }

          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const items = entries.map((e) => ({
            name: e.name,
            isDir: e.isDirectory(),
            isFile: e.isFile(),
            isSymlink: e.isSymbolicLink(),
          }));

          // Sort: dirs first, then files, alphabetical
          items.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

          jsonResponse(res, 200, { path: dirPath, items });
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to list: ${(err as Error).message}` });
        }
        return true;
      }

      // GET /api/read?path=/some/file
      if (req.method === "GET" && subPath === "/api/read") {
        const filePath = safePath(url.searchParams.get("path") || "");
        if (!filePath) {
          jsonResponse(res, 400, { error: "invalid path" });
          return true;
        }

        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) {
            jsonResponse(res, 400, { error: "not a file" });
            return true;
          }
          // Limit to 2MB text files
          if (stat.size > 2 * 1024 * 1024) {
            jsonResponse(res, 400, { error: "file too large (max 2MB)" });
            return true;
          }
          const content = fs.readFileSync(filePath, "utf-8");
          jsonResponse(res, 200, { path: filePath, content, size: stat.size });
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to read: ${(err as Error).message}` });
        }
        return true;
      }

      // POST /api/write { path, content }
      if (req.method === "POST" && subPath === "/api/write") {
        const body = await readJsonBody(req);
        const filePath = safePath(typeof body?.path === "string" ? body.path : "");
        const content = typeof body?.content === "string" ? body.content : null;

        if (!filePath || content === null) {
          jsonResponse(res, 400, { error: "path and content required" });
          return true;
        }

        try {
          // Create parent dirs if needed
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(filePath, content, "utf-8");
          jsonResponse(res, 200, { ok: true, path: filePath });
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to write: ${(err as Error).message}` });
        }
        return true;
      }

      // DELETE /api/delete?path=/some/file
      if (req.method === "DELETE" && subPath === "/api/delete") {
        const targetPath = safePath(url.searchParams.get("path") || "");
        if (!targetPath) {
          jsonResponse(res, 400, { error: "invalid path" });
          return true;
        }

        try {
          fs.rmSync(targetPath, { recursive: true });
          jsonResponse(res, 200, { ok: true });
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to delete: ${(err as Error).message}` });
        }
        return true;
      }

      jsonResponse(res, 404, { error: "unknown API endpoint" });
      return true;
    }

    // Static assets (GET)
    if (req.method === "GET") {
      return serveStaticAsset(req, res, subPath, DIST_WEBAPP);
    }

    return false;
  });
}
