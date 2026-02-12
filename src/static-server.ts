import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Serve static assets from the dist/webapp/ directory.
 * Adds Telegram-friendly CSP headers so the page can load inside the
 * Telegram Mini App iframe.
 */
export function serveStaticAsset(
  _req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  distRoot: string,
): boolean {
  // Default to index.html for root or SPA fallback
  const safePath = urlPath === "/" || urlPath === "" ? "/index.html" : urlPath;

  // Prevent directory traversal
  const resolved = path.resolve(distRoot, safePath.replace(/^\//, ""));
  if (!resolved.startsWith(distRoot)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }

  // Resolve symlinks and re-verify
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    // File doesn't exist — try SPA fallback
    const indexPath = path.join(distRoot, "index.html");
    if (fs.existsSync(indexPath)) {
      return sendFile(res, indexPath, ".html");
    }
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  if (!realPath.startsWith(fs.realpathSync(distRoot))) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }

  try {
    if (fs.statSync(realPath).isDirectory()) {
      const indexPath = path.join(distRoot, "index.html");
      if (fs.existsSync(indexPath)) {
        return sendFile(res, indexPath, ".html");
      }
      res.statusCode = 404;
      res.end("Not Found");
      return true;
    }
  } catch {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  const ext = path.extname(realPath).toLowerCase();
  return sendFile(res, realPath, ext);
}

function sendFile(res: ServerResponse, filePath: string, ext: string): boolean {
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  // Allow Telegram to embed in iframe
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://web.telegram.org https://*.telegram.org",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // Immutable cache for hashed assets, short cache for html
  if (ext === ".html") {
    res.setHeader("Cache-Control", "no-cache");
  } else {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  res.statusCode = 200;
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
  return true;
}
