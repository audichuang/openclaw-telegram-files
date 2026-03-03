import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createPairingCode } from "./pairing.js";
import { getFilesRuntime } from "./runtime.js";
import { serveStaticAsset } from "./static-server.js";
import { checkAuth, jsonResponse } from "./auth.js";
import {
	handleDelete,
	handleExchange,
	handleHome,
	handleLs,
	handleMkdir,
	handleRead,
	handleSearch,
	handleUpload,
	handleWrite,
} from "./api-handlers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_WEBAPP = path.resolve(__dirname, "..", "dist", "webapp");

export type TelegramFilesPluginConfig = {
	externalUrl?: string;
	allowedPaths?: string[];
};

const PREFIX = "/plugins/telegram-files";

export function registerAll(api: OpenClawPluginApi) {
	const raw = api.pluginConfig as Record<string, unknown> | undefined;
	const pluginConfig: TelegramFilesPluginConfig = {
		externalUrl:
			typeof raw?.externalUrl === "string" ? raw.externalUrl : undefined,
		allowedPaths: Array.isArray(raw?.allowedPaths)
			? (raw.allowedPaths as unknown[]).filter(
					(p): p is string => typeof p === "string",
				)
			: [],
	};
	const allowedPaths = pluginConfig.allowedPaths ?? [];

	// Derive CORS origin from externalUrl (deny cross-origin when unconfigured or malformed)
	let corsOrigin = "null";
	if (pluginConfig.externalUrl) {
		try {
			const parsed = new URL(pluginConfig.externalUrl);
			corsOrigin = parsed.origin;
		} catch {
			// Malformed URL — keep "null" to deny cross-origin requests
		}
	}

	// ─── Helper: CORS preflight handler wrapper ────────────────────────
	const withCors = (
		handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
	) => {
		return async (req: IncomingMessage, res: ServerResponse) => {
			if (req.method === "OPTIONS") {
				res.setHeader("Access-Control-Allow-Origin", corsOrigin);
				res.setHeader(
					"Access-Control-Allow-Methods",
					"GET, POST, PUT, DELETE, OPTIONS",
				);
				res.setHeader(
					"Access-Control-Allow-Headers",
					"Content-Type, Authorization",
				);
				res.setHeader("Referrer-Policy", "no-referrer");
				res.statusCode = 204;
				res.end();
				return;
			}
			await handler(req, res);
		};
	};

	// ─── Helper: auth-guarded handler wrapper ──────────────────────────
	const withAuth = (
		handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
	) => {
		return async (req: IncomingMessage, res: ServerResponse) => {
			if (!checkAuth(req)) {
				jsonResponse(res, 401, { error: "unauthorized" }, corsOrigin);
				return;
			}
			await handler(req, res);
		};
	};

	// 1. Register /files command
	api.registerCommand({
		name: "files",
		description:
			"Open file manager on mobile (optional: /files /path/to/dir)",
		acceptsArgs: true,
		handler: async (ctx) => {
			const cfg = ctx.config;
			const externalUrl = pluginConfig.externalUrl;

			if (!externalUrl) {
				return {
					text: 'Please set externalUrl: openclaw config set plugins.entries.telegram-files.config.externalUrl "https://your-host"',
				};
			}

			const gatewayToken = cfg.gateway?.auth?.token;
			if (!gatewayToken) {
				return {
					text: "Gateway auth token not found. Set gateway.auth.token in config.",
				};
			}

			const code = createPairingCode();

			// Build Mini App URL with optional start path
			const startPath = ctx.args?.trim() || "";
			let miniAppUrl = `${externalUrl}${PREFIX}/?pair=${code}`;
			if (startPath) {
				miniAppUrl += `&path=${encodeURIComponent(startPath)}`;
			}

			if (ctx.channel === "telegram" && ctx.senderId) {
				const runtime = getFilesRuntime();
				const { token } =
					runtime.channel.telegram.resolveTelegramToken(cfg);
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
							return { text: "" };
						}
					} catch {
						// Fall through to text fallback
					}
				}
			}

			return { text: `Open file manager: ${miniAppUrl}` };
		},
	});

	// 2. Register HTTP routes (one per API endpoint)
	// Token exchange (no auth required, CORS enabled)
	api.registerHttpRoute({
		path: `${PREFIX}/api/exchange`,
		handler: withCors(async (req, res) => {
			if (req.method !== "POST") {
				jsonResponse(res, 405, { error: "method not allowed" }, corsOrigin);
				return;
			}
			await handleExchange(req, res, corsOrigin);
		}),
	});

	// GET /api/home
	api.registerHttpRoute({
		path: `${PREFIX}/api/home`,
		handler: withCors(withAuth((req, res) => {
			if (req.method !== "GET") {
				jsonResponse(res, 405, { error: "method not allowed" }, corsOrigin);
				return;
			}
			handleHome(res, allowedPaths, corsOrigin);
		})),
	});

	// GET /api/ls
	api.registerHttpRoute({
		path: `${PREFIX}/api/ls`,
		handler: withCors(withAuth(async (req, res) => {
			if (req.method !== "GET") {
				jsonResponse(res, 405, { error: "method not allowed" }, corsOrigin);
				return;
			}
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			await handleLs(url, res, allowedPaths, corsOrigin);
		})),
	});

	// GET /api/read
	api.registerHttpRoute({
		path: `${PREFIX}/api/read`,
		handler: withCors(withAuth(async (req, res) => {
			if (req.method !== "GET") {
				jsonResponse(res, 405, { error: "method not allowed" }, corsOrigin);
				return;
			}
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			await handleRead(url, res, allowedPaths, corsOrigin);
		})),
	});

	// POST /api/write
	api.registerHttpRoute({
		path: `${PREFIX}/api/write`,
		handler: withCors(withAuth(async (req, res) => {
			if (req.method !== "POST") {
				jsonResponse(res, 405, { error: "method not allowed" }, corsOrigin);
				return;
			}
			await handleWrite(req, res, allowedPaths, corsOrigin);
		})),
	});

	// POST /api/upload
	api.registerHttpRoute({
		path: `${PREFIX}/api/upload`,
		handler: withCors(withAuth(async (req, res) => {
			if (req.method !== "POST") {
				jsonResponse(res, 405, { error: "method not allowed" }, corsOrigin);
				return;
			}
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			await handleUpload(req, url, res, allowedPaths, corsOrigin);
		})),
	});

	// POST /api/mkdir
	api.registerHttpRoute({
		path: `${PREFIX}/api/mkdir`,
		handler: withCors(withAuth(async (req, res) => {
			if (req.method !== "POST") {
				jsonResponse(res, 405, { error: "method not allowed" }, corsOrigin);
				return;
			}
			await handleMkdir(req, res, allowedPaths, corsOrigin);
		})),
	});

	// DELETE /api/delete
	api.registerHttpRoute({
		path: `${PREFIX}/api/delete`,
		handler: withCors(withAuth(async (req, res) => {
			if (req.method !== "DELETE") {
				jsonResponse(res, 405, { error: "method not allowed" }, corsOrigin);
				return;
			}
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			await handleDelete(req, url, res, allowedPaths, corsOrigin);
		})),
	});

	// GET /api/search
	api.registerHttpRoute({
		path: `${PREFIX}/api/search`,
		handler: withCors(withAuth(async (req, res) => {
			if (req.method !== "GET") {
				jsonResponse(res, 405, { error: "method not allowed" }, corsOrigin);
				return;
			}
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			await handleSearch(url, res, allowedPaths, corsOrigin);
		})),
	});

	// 3. Register static webapp routes
	// SPA index.html (with and without trailing slash)
	const spaHandler = async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "GET") {
			res.statusCode = 405;
			res.end("Method Not Allowed");
			return;
		}
		await serveStaticAsset(req, res, "/", DIST_WEBAPP);
	};

	api.registerHttpRoute({ path: `${PREFIX}/`, handler: spaHandler });
	api.registerHttpRoute({ path: PREFIX, handler: spaHandler });

	// Dynamically register routes for hashed static assets (JS, CSS, etc.)
	// Since registerHttpRoute uses exact path matching, we scan dist/webapp/
	// at startup and register each asset file individually.
	try {
		const assetsDir = path.join(DIST_WEBAPP, "assets");
		if (fs.existsSync(assetsDir)) {
			const assetFiles = fs.readdirSync(assetsDir);
			for (const file of assetFiles) {
				const assetPath = `${PREFIX}/assets/${file}`;
				api.registerHttpRoute({
					path: assetPath,
					handler: async (req: IncomingMessage, res: ServerResponse) => {
						if (req.method !== "GET") {
							res.statusCode = 405;
							res.end("Method Not Allowed");
							return;
						}
						await serveStaticAsset(req, res, `/assets/${file}`, DIST_WEBAPP);
					},
				});
			}
		}
	} catch {
		// Non-fatal: static assets may not be built yet
	}
}
