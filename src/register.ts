import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
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
const MAX_ACTIVE_TOKENS = 200;
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
    let resolved = false;
    req.on("data", (chunk: Buffer) => {
      if (resolved) return;
      size += chunk.length;
      if (size > maxBytes) {
        resolved = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (resolved) return;
      resolved = true;
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => {
      if (resolved) return;
      resolved = true;
      resolve(null);
    });
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

function jsonResponse(res: ServerResponse, status: number, data: unknown, corsOrigin: string) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

/** Prevent path traversal: resolve and verify the path is absolute. Resolves symlinks including parent dirs. */
async function safePath(rawPath: string): Promise<string | null> {
  if (!rawPath || rawPath.includes("\0")) return null;
  const resolved = path.resolve(rawPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    // Path doesn't exist yet (write/mkdir) — resolve the deepest existing parent
    let current = resolved;
    while (current !== path.dirname(current)) {
      const parent = path.dirname(current);
      try {
        const realParent = await fs.realpath(parent);
        return path.join(realParent, path.basename(current));
      } catch {
        current = parent;
      }
    }
    return resolved;
  }
}

/** Check if a resolved path is within allowed paths. */
async function isPathAllowed(resolvedPath: string, allowedPaths: string[]): Promise<boolean> {
  const paths = allowedPaths.length > 0
    ? allowedPaths
    : [os.homedir()];
  for (const base of paths) {
    let resolvedBase: string;
    try {
      resolvedBase = await fs.realpath(path.resolve(base));
    } catch {
      resolvedBase = path.resolve(base);
    }
    if (resolvedPath === resolvedBase || resolvedPath.startsWith(resolvedBase + path.sep)) {
      return true;
    }
  }
  return false;
}

/** Check if a path is an allowed root itself (prevent deleting root allowed dirs). */
async function isAllowedRoot(resolvedPath: string, allowedPaths: string[]): Promise<boolean> {
  const paths = allowedPaths.length > 0
    ? allowedPaths
    : [os.homedir()];
  for (const base of paths) {
    let resolvedBase: string;
    try {
      resolvedBase = await fs.realpath(path.resolve(base));
    } catch {
      resolvedBase = path.resolve(base);
    }
    if (resolvedPath === resolvedBase) return true;
  }
  return false;
}

/** Sanitize error message to avoid leaking internal paths. */
function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\/[^\s,)]+/g, "[path]");
}

/** Truncate token for logging (first 8 chars). */
function tokenTag(req: IncomingMessage): string {
  const t = extractBearerToken(req);
  return t ? t.slice(0, 8) + "..." : "unknown";
}

/** Async recursive file name search. */
async function searchFiles(
  basePath: string,
  query: string,
  maxResults = 50,
  maxDepth = 5,
): Promise<{ path: string; name: string; isDir: boolean }[]> {
  const results: { path: string; name: string; isDir: boolean }[] = [];
  const lowerQuery = query.toLowerCase();
  const visited = new Set<string>();

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || results.length >= maxResults) return;

    // Detect symlink cycles
    try {
      const realDir = await fs.realpath(dir);
      if (visited.has(realDir)) return;
      visited.add(realDir);
    } catch {
      return;
    }

    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
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
        await walk(full, depth + 1);
      }
    }
  }

  await walk(basePath, 0);
  return results;
}

export function registerAll(api: OpenClawPluginApi) {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;
  const pluginConfig: TelegramFilesPluginConfig = {
    externalUrl: typeof raw?.externalUrl === "string" ? raw.externalUrl : undefined,
    allowedPaths: Array.isArray(raw?.allowedPaths) ? (raw.allowedPaths as unknown[]).filter((p): p is string => typeof p === "string") : [],
  };
  const allowedPaths = pluginConfig.allowedPaths ?? [];

  // Derive CORS origin from externalUrl
  let corsOrigin = "*";
  if (pluginConfig.externalUrl) {
    try {
      const parsed = new URL(pluginConfig.externalUrl);
      corsOrigin = parsed.origin;
    } catch {
      corsOrigin = pluginConfig.externalUrl;
    }
  }

  // 1. Register /files command
  api.registerCommand({
    name: "files",
    description: "Open file manager on mobile (optional: /files /path/to/dir)",
    acceptsArgs: true,
    handler: async (ctx) => {
      const cfg = ctx.config;
      const externalUrl = pluginConfig.externalUrl;

      if (!externalUrl) {
        return { text: 'Please set externalUrl: openclaw config set plugins.entries.telegram-files.config.externalUrl "https://your-host"' };
      }

      const gatewayToken = cfg.gateway?.auth?.token;
      if (!gatewayToken) {
        return { text: "Gateway auth token not found. Set gateway.auth.token in config." };
      }

      const code = createPairingCode();

      // Build Mini App URL with optional start path
      const startPath = ctx.args?.trim() || "";
      let miniAppUrl = `${externalUrl}/plugins/telegram-files/?pair=${code}`;
      if (startPath) {
        miniAppUrl += `&path=${encodeURIComponent(startPath)}`;
      }

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
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.statusCode = 204;
      res.end();
      return true;
    }

    // --- Token exchange (no auth required) ---
    if (req.method === "POST" && subPath === "/api/exchange") {
      const body = await readJsonBody(req);
      const pairCode = typeof body?.pairCode === "string" ? body.pairCode : "";
      const valid = exchangePairingCode(pairCode);

      if (!valid) {
        jsonResponse(res, 401, { error: "invalid or expired pairing code" }, corsOrigin);
        return true;
      }

      // Evict oldest token if at capacity
      if (activeTokens.size >= MAX_ACTIVE_TOKENS) {
        let oldestKey: string | null = null;
        let oldestExp = Infinity;
        for (const [k, v] of activeTokens) {
          if (v < oldestExp) { oldestExp = v; oldestKey = k; }
        }
        if (oldestKey) activeTokens.delete(oldestKey);
      }

      // Create a session token with TTL (256-bit)
      const sessionToken = crypto.randomBytes(32).toString("hex");
      activeTokens.set(sessionToken, Date.now() + TOKEN_TTL_MS);
      jsonResponse(res, 200, { token: sessionToken }, corsOrigin);
      return true;
    }

    // --- All other API endpoints require auth ---
    if (subPath.startsWith("/api/")) {
      if (!checkAuth(req)) {
        jsonResponse(res, 401, { error: "unauthorized" }, corsOrigin);
        return true;
      }

      // GET /api/home — return the default start directory
      if (req.method === "GET" && subPath === "/api/home") {
        const home = allowedPaths.length > 0 ? path.resolve(allowedPaths[0]) : os.homedir();
        jsonResponse(res, 200, { path: home }, corsOrigin);
        return true;
      }

      // GET /api/ls?path=/some/dir
      if (req.method === "GET" && subPath === "/api/ls") {
        const dirPath = await safePath(url.searchParams.get("path") || "/");
        if (!dirPath || !(await isPathAllowed(dirPath, allowedPaths))) {
          jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
          return true;
        }

        try {
          const stat = await fs.stat(dirPath);
          if (!stat.isDirectory()) {
            jsonResponse(res, 400, { error: "not a directory" }, corsOrigin);
            return true;
          }

          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          const items = await Promise.all(entries.map(async (e) => {
            const fullPath = path.join(dirPath, e.name);
            let size = 0;
            let mtime = 0;
            try {
              const s = await fs.stat(fullPath);
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
          }));

          // Sort: dirs first, then files, alphabetical
          items.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

          jsonResponse(res, 200, { path: dirPath, items }, corsOrigin);
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to list: ${sanitizeError(err)}` }, corsOrigin);
        }
        return true;
      }

      // GET /api/read?path=/some/file
      if (req.method === "GET" && subPath === "/api/read") {
        const filePath = await safePath(url.searchParams.get("path") || "");
        if (!filePath || !(await isPathAllowed(filePath, allowedPaths))) {
          jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
          return true;
        }

        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) {
            jsonResponse(res, 400, { error: "not a file" }, corsOrigin);
            return true;
          }
          // Limit to 2MB text files
          if (stat.size > 2 * 1024 * 1024) {
            jsonResponse(res, 400, { error: "file too large (max 2MB)" }, corsOrigin);
            return true;
          }

          // Binary detection: check first 512 bytes for null bytes
          const fd = await fs.open(filePath, "r");
          let isBinary = false;
          try {
            const probe = Buffer.alloc(512);
            const { bytesRead } = await fd.read(probe, 0, 512, 0);
            isBinary = probe.subarray(0, bytesRead).includes(0);
          } finally {
            await fd.close();
          }
          if (isBinary) {
            jsonResponse(res, 400, { error: "binary file — cannot edit" }, corsOrigin);
            return true;
          }

          const content = await fs.readFile(filePath, "utf-8");
          jsonResponse(res, 200, { path: filePath, content, size: stat.size }, corsOrigin);
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to read: ${sanitizeError(err)}` }, corsOrigin);
        }
        return true;
      }

      // POST /api/write { path, content }
      if (req.method === "POST" && subPath === "/api/write") {
        const body = await readJsonBody(req);
        const filePath = await safePath(typeof body?.path === "string" ? body.path : "");
        const content = typeof body?.content === "string" ? body.content : null;

        if (!filePath || content === null) {
          jsonResponse(res, 400, { error: "path and content required" }, corsOrigin);
          return true;
        }

        if (!(await isPathAllowed(filePath, allowedPaths))) {
          jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
          return true;
        }

        try {
          const dir = path.dirname(filePath);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(filePath, content, "utf-8");
          console.log(`[telegram-files] WRITE ${filePath} by token ${tokenTag(req)}`);
          jsonResponse(res, 200, { ok: true, path: filePath }, corsOrigin);
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to write: ${sanitizeError(err)}` }, corsOrigin);
        }
        return true;
      }

      // POST /api/upload — raw binary upload with path in query string
      if (req.method === "POST" && subPath === "/api/upload") {
        const targetDir = await safePath(url.searchParams.get("dir") || "");
        const fileName = url.searchParams.get("name") || "";

        if (!targetDir || !fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0") || fileName === ".." || fileName === ".") {
          jsonResponse(res, 400, { error: "dir and valid name required" }, corsOrigin);
          return true;
        }

        const constructedPath = path.join(targetDir, fileName);
        const filePath = await safePath(constructedPath);
        if (!filePath || !(await isPathAllowed(filePath, allowedPaths))) {
          jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
          return true;
        }

        // Read raw body (max 50MB)
        const maxUpload = 50 * 1024 * 1024;
        const chunks: Buffer[] = [];
        let size = 0;
        let overflow = false;
        let requestError = false;

        await new Promise<void>((resolve) => {
          req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxUpload) {
              overflow = true;
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          req.on("end", () => resolve());
          req.on("error", () => { requestError = true; resolve(); });
          req.on("close", () => resolve());
        });

        if (overflow) {
          jsonResponse(res, 413, { error: "file too large (max 50MB)" }, corsOrigin);
          return true;
        }
        if (requestError) {
          jsonResponse(res, 500, { error: "upload stream error" }, corsOrigin);
          return true;
        }

        try {
          const dir = path.dirname(filePath);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(filePath, Buffer.concat(chunks));
          console.log(`[telegram-files] UPLOAD ${filePath} (${size} bytes) by token ${tokenTag(req)}`);
          jsonResponse(res, 200, { ok: true, path: filePath, size }, corsOrigin);
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to upload: ${sanitizeError(err)}` }, corsOrigin);
        }
        return true;
      }

      // POST /api/mkdir { path }
      if (req.method === "POST" && subPath === "/api/mkdir") {
        const body = await readJsonBody(req);
        const dirPath = await safePath(typeof body?.path === "string" ? body.path : "");

        if (!dirPath) {
          jsonResponse(res, 400, { error: "path required" }, corsOrigin);
          return true;
        }

        if (!(await isPathAllowed(dirPath, allowedPaths))) {
          jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
          return true;
        }

        try {
          await fs.mkdir(dirPath, { recursive: true });
          console.log(`[telegram-files] MKDIR ${dirPath} by token ${tokenTag(req)}`);
          jsonResponse(res, 200, { ok: true, path: dirPath }, corsOrigin);
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to mkdir: ${sanitizeError(err)}` }, corsOrigin);
        }
        return true;
      }

      // DELETE /api/delete?path=/some/file
      if (req.method === "DELETE" && subPath === "/api/delete") {
        const targetPath = await safePath(url.searchParams.get("path") || "");
        if (!targetPath) {
          jsonResponse(res, 400, { error: "invalid path" }, corsOrigin);
          return true;
        }

        if (!(await isPathAllowed(targetPath, allowedPaths))) {
          jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
          return true;
        }

        // Prevent deleting allowed root directories (e.g. home dir)
        if (await isAllowedRoot(targetPath, allowedPaths)) {
          jsonResponse(res, 403, { error: "cannot delete a root allowed path" }, corsOrigin);
          return true;
        }

        try {
          await fs.rm(targetPath, { recursive: true });
          console.log(`[telegram-files] DELETE ${targetPath} by token ${tokenTag(req)}`);
          jsonResponse(res, 200, { ok: true }, corsOrigin);
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to delete: ${sanitizeError(err)}` }, corsOrigin);
        }
        return true;
      }

      // GET /api/search?path=/base&q=keyword
      if (req.method === "GET" && subPath === "/api/search") {
        const basePath = await safePath(url.searchParams.get("path") || "/");
        const query = (url.searchParams.get("q") || "").trim();

        if (!basePath || !(await isPathAllowed(basePath, allowedPaths))) {
          jsonResponse(res, 403, { error: "path not allowed" }, corsOrigin);
          return true;
        }

        if (query.length < 1 || query.length > 256) {
          jsonResponse(res, 400, { error: "query parameter 'q' required (1-256 chars)" }, corsOrigin);
          return true;
        }

        try {
          const results = await searchFiles(basePath, query);
          jsonResponse(res, 200, { path: basePath, query, results }, corsOrigin);
        } catch (err) {
          jsonResponse(res, 500, { error: `Failed to search: ${sanitizeError(err)}` }, corsOrigin);
        }
        return true;
      }

      jsonResponse(res, 404, { error: "unknown API endpoint" }, corsOrigin);
      return true;
    }

    // Static assets (GET)
    if (req.method === "GET") {
      return serveStaticAsset(req, res, subPath, DIST_WEBAPP);
    }

    return false;
  });
}
