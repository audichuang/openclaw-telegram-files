import path from "node:path";
import os from "node:os";
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
  allowedPaths?: string[];
};

// --- Token TTL (24h) ---
const activeTokens = new Map<string, number>(); // token → expiresAt
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Periodic cleanup every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of activeTokens) {
    if (now > exp) activeTokens.delete(token);
  }
}, 60 * 60 * 1000);

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

/** Extract bearer token from Authorization header. */
function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

/** Check bearer token with TTL expiration. */
function checkAuth(req: IncomingMessage): boolean {
  const token = extractBearerToken(req);
  if (!token) return false;
  const expiresAt = activeTokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    activeTokens.delete(token);
    return false;
  }
  return true;
}

function jsonResponse(res: ServerResponse, status: number, data: unknown) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

/** Prevent path traversal: resolve and verify the path is absolute. Resolves symlinks when path exists. */
function safePath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes("\0")) return null;
  const resolved = path.resolve(rawPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved; // path may not exist yet (e.g. write/mkdir)
  }
}

/** Check if a resolved path is within allowed paths. */
function isPathAllowed(resolvedPath: string, allowedPaths: string[]): boolean {
  const paths = allowedPaths.length > 0
    ? allowedPaths
    : [os.homedir()];
  return paths.some((base) => {
    let resolvedBase: string;
    try {
      resolvedBase = fs.realpathSync(path.resolve(base));
    } catch {
      resolvedBase = path.resolve(base);
    }
    return resolvedPath === resolvedBase || resolvedPath.startsWith(resolvedBase + path.sep);
  });
}

/** Check if a path is an allowed root itself (prevent deleting root allowed dirs). */
function isAllowedRoot(resolvedPath: string, allowedPaths: string[]): boolean {
  const paths = allowedPaths.length > 0
    ? allowedPaths
    : [os.homedir()];
  return paths.some((base) => {
    let resolvedBase: string;
    try {
      resolvedBase = fs.realpathSync(path.resolve(base));
    } catch {
      resolvedBase = path.resolve(base);
    }
    return resolvedPath === resolvedBase;
  });
}

/** Sanitize error message to avoid leaking internal paths. */
function sanitizeError(err: Error): string {
  return err.message.replace(/\/[^\s,)]+/g, "[path]");
}

/** Truncate token for logging (first 8 chars). */
function tokenTag(req: IncomingMessage): string {
  const t = extractBearerToken(req);
  return t ? t.slice(0, 8) + "..." : "unknown";
}

/** Recursive file name search. */
function searchFiles(
  basePath: string,
  query: string,
  maxResults = 50,
  maxDepth = 5,
): { path: string; name: string; isDir: boolean }[] {
  const results: { path: string; name: string; isDir: boolean }[] = [];
  const lowerQuery = query.toLowerCase();

  function walk(dir: string, depth: number) {
    if (depth > maxDepth || results.length >= maxResults) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied etc
    }
    for (const e of entries) {
      if (results.length >= maxResults) return;
      if (e.name.startsWith(".")) continue; // skip hidden
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase().includes(lowerQuery)) {
        results.push({ path: full, name: e.name, isDir: e.isDirectory() });
      }
      if (e.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  }

  walk(basePath, 0);
  return results;
}

export function registerAll(api: OpenClawPluginApi) {
  const pluginConfig = api.pluginConfig as TelegramFilesPluginConfig | undefined;
  const allowedPaths = pluginConfig?.allowedPaths ?? [];

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

      // Create a session token with TTL
      const sessionToken = crypto.randomUUID();
      activeTokens.set(sessionToken, Date.now() + TOKEN_TTL_MS);
      jsonResponse(res, 200, { token: sessionToken });
      return true;
    }

    // --- All other API endpoints require auth ---
    if (subPath.startsWith("/api/")) {
      if (!checkAuth(req)) {
        jsonResponse(res, 401, { error: "unauthorized" });
        return true;
      }

      // GET /api/home — return the default start directory
      if (req.method === "GET" && subPath === "/api/home") {
        const home = allowedPaths.length > 0 ? path.resolve(allowedPaths[0]) : os.homedir();
        jsonResponse(res, 200, { path: home });
        return true;
      }

      // GET /api/ls?path=/some/dir
      if (req.method === "GET" && subPath === "/api/ls") {
        const dirPath = safePath(url.searchParams.get("path") || "/");
        if (!dirPath || !isPathAllowed(dirPath, allowedPaths)) {
          jsonResponse(res, 403, { error: "path not allowed" });
          return true;
        }

        try {
          const stat = fs.statSync(dirPath);
          if (!stat.isDirectory()) {
            jsonResponse(res, 400, { error: "not a directory" });
            return true;
          }

          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const items = entries.map((e) => {
            const fullPath = path.join(dirPath, e.name);
            let size = 0;
            let mtime = 0;
            try {
              const s = fs.statSync(fullPath);
              size = s.size;
              mtime = s.mtimeMs;
            } catch { /* permission denied etc */ }
            return {
              name: e.name,
              isDir: e.isDirectory(),
              isFile: e.isFile(),
              isSymlink: e.isSymbolicLink(),
              size,
              mtime,
            };
          });

          // Sort: dirs first, then files, alphabetical
          items.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

          jsonResponse(res, 200, { path: dirPath, items });
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to list: ${sanitizeError(err as Error)}` });
        }
        return true;
      }

      // GET /api/read?path=/some/file
      if (req.method === "GET" && subPath === "/api/read") {
        const filePath = safePath(url.searchParams.get("path") || "");
        if (!filePath || !isPathAllowed(filePath, allowedPaths)) {
          jsonResponse(res, 403, { error: "path not allowed" });
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

          // Binary detection: check first 512 bytes for null bytes
          const probe = Buffer.alloc(512);
          const fd = fs.openSync(filePath, "r");
          let isBinary = false;
          try {
            const bytesRead = fs.readSync(fd, probe, 0, 512, 0);
            isBinary = probe.subarray(0, bytesRead).includes(0);
          } finally {
            fs.closeSync(fd);
          }
          if (isBinary) {
            jsonResponse(res, 400, { error: "binary file — cannot edit" });
            return true;
          }

          const content = fs.readFileSync(filePath, "utf-8");
          jsonResponse(res, 200, { path: filePath, content, size: stat.size });
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to read: ${sanitizeError(err as Error)}` });
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

        if (!isPathAllowed(filePath, allowedPaths)) {
          jsonResponse(res, 403, { error: "path not allowed" });
          return true;
        }

        try {
          // Create parent dirs if needed
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(filePath, content, "utf-8");
          console.log(`[telegram-files] WRITE ${filePath} by token ${tokenTag(req)}`);
          jsonResponse(res, 200, { ok: true, path: filePath });
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to write: ${sanitizeError(err as Error)}` });
        }
        return true;
      }

      // POST /api/mkdir { path }
      if (req.method === "POST" && subPath === "/api/mkdir") {
        const body = await readJsonBody(req);
        const dirPath = safePath(typeof body?.path === "string" ? body.path : "");

        if (!dirPath) {
          jsonResponse(res, 400, { error: "path required" });
          return true;
        }

        if (!isPathAllowed(dirPath, allowedPaths)) {
          jsonResponse(res, 403, { error: "path not allowed" });
          return true;
        }

        try {
          fs.mkdirSync(dirPath, { recursive: true });
          console.log(`[telegram-files] MKDIR ${dirPath} by token ${tokenTag(req)}`);
          jsonResponse(res, 200, { ok: true, path: dirPath });
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to mkdir: ${sanitizeError(err as Error)}` });
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

        if (!isPathAllowed(targetPath, allowedPaths)) {
          jsonResponse(res, 403, { error: "path not allowed" });
          return true;
        }

        // Prevent deleting allowed root directories (e.g. home dir)
        if (isAllowedRoot(targetPath, allowedPaths)) {
          jsonResponse(res, 403, { error: "cannot delete a root allowed path" });
          return true;
        }

        try {
          fs.rmSync(targetPath, { recursive: true });
          console.log(`[telegram-files] DELETE ${targetPath} by token ${tokenTag(req)}`);
          jsonResponse(res, 200, { ok: true });
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to delete: ${sanitizeError(err as Error)}` });
        }
        return true;
      }

      // GET /api/search?path=/base&q=keyword
      if (req.method === "GET" && subPath === "/api/search") {
        const basePath = safePath(url.searchParams.get("path") || "/");
        const query = url.searchParams.get("q") || "";

        if (!basePath || !isPathAllowed(basePath, allowedPaths)) {
          jsonResponse(res, 403, { error: "path not allowed" });
          return true;
        }

        if (!query || query.length < 1 || query.length > 256) {
          jsonResponse(res, 400, { error: "query parameter 'q' required (1-256 chars)" });
          return true;
        }

        try {
          const results = searchFiles(basePath, query);
          jsonResponse(res, 200, { path: basePath, query, results });
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to search: ${sanitizeError(err as Error)}` });
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
