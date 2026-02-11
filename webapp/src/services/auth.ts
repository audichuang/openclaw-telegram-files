import { cloudStorageGet, cloudStorageSet } from "./telegram.js";

const TOKEN_KEY = "gw_token";
const WS_URL_KEY = "gw_ws_url";

export type AuthResult = {
  token: string;
  wsUrl: string;
};

/** Try to restore a saved token from Telegram CloudStorage. */
export async function restoreToken(): Promise<AuthResult | null> {
  const token = await cloudStorageGet(TOKEN_KEY);
  const wsUrl = await cloudStorageGet(WS_URL_KEY);
  if (token && wsUrl) return { token, wsUrl };
  return null;
}

/** Save token + wsUrl to Telegram CloudStorage for future sessions. */
export async function saveToken(auth: AuthResult): Promise<void> {
  await cloudStorageSet(TOKEN_KEY, auth.token);
  await cloudStorageSet(WS_URL_KEY, auth.wsUrl);
}

/**
 * Exchange a one-time pairing code for a gateway token.
 * The exchange endpoint is served by the plugin's HTTP handler.
 */
export async function exchangePairCode(pairCode: string): Promise<AuthResult> {
  // Derive exchange URL from current location (same origin)
  const base = window.location.origin;
  const resp = await fetch(`${base}/plugins/telegram-files/api/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairCode }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as Record<string, string>).error ?? "Exchange failed");
  }
  const data = (await resp.json()) as { token: string; wsUrl: string };
  return { token: data.token, wsUrl: data.wsUrl };
}
