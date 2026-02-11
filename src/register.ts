import path from "node:path";
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
  webappUrl?: string;
};

/** Read a JSON body from an IncomingMessage. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 4096;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) {
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

export function registerAll(api: OpenClawPluginApi) {
  const pluginConfig = api.pluginConfig as TelegramFilesPluginConfig | undefined;

  // 1. Register /files command
  api.registerCommand({
    name: "files",
    description: "Open file manager to edit agent files on mobile",
    handler: async (ctx) => {
      const cfg = ctx.config;
      const externalUrl = pluginConfig?.externalUrl;

      if (!externalUrl) {
        return { text: "Please set plugins.telegram-files.externalUrl in config." };
      }

      const gatewayToken = cfg.gateway?.auth?.token;
      if (!gatewayToken) {
        return { text: "Gateway auth token not found. Set gateway.auth.token in config." };
      }

      const code = createPairingCode(gatewayToken);
      const miniAppUrl = `${externalUrl}/plugins/telegram-files/?pair=${code}`;

      // For Telegram: send a web_app inline keyboard button directly via Bot API.
      // PluginCommandContext has senderId but not chatId; in DMs they are equivalent.
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
                  text: "Tap to manage agent files:",
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: "Open File Manager",
                          web_app: { url: miniAppUrl },
                        },
                      ],
                    ],
                  },
                }),
              },
            );
            if (resp.ok) {
              // Already sent via Telegram API; return empty to suppress SDK reply
              return { text: "" };
            }
          } catch {
            // Fall through to text-only fallback
          }
        }
      }

      // Fallback for non-Telegram channels or if Telegram send fails
      return { text: `Open file manager: ${miniAppUrl}` };
    },
  });

  // 2. Register HTTP handler for token exchange + static assets
  api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const prefix = "/plugins/telegram-files";

    // Only handle requests under our plugin path
    if (!url.pathname.startsWith(prefix)) {
      return false;
    }

    const subPath = url.pathname.slice(prefix.length) || "/";

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.statusCode = 204;
      res.end();
      return true;
    }

    // Token exchange endpoint
    if (req.method === "POST" && subPath === "/api/exchange") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");

      const body = await readJsonBody(req);
      const pairCode = typeof body?.pairCode === "string" ? body.pairCode : "";
      const token = exchangePairingCode(pairCode);

      if (!token) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "invalid or expired pairing code" }));
        return true;
      }

      // Return the token and ws URL for the Mini App to connect
      const wsUrl = pluginConfig?.externalUrl?.replace(/^http/, "ws") ?? "ws://localhost:18789";
      res.statusCode = 200;
      res.end(JSON.stringify({ token, wsUrl }));
      return true;
    }

    // Static assets (GET)
    if (req.method === "GET") {
      return serveStaticAsset(req, res, subPath, DIST_WEBAPP);
    }

    return false;
  });
}
