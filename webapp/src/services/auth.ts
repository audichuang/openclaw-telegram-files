import { cloudStorageGet, cloudStorageSet } from "./telegram.js";

const TOKEN_KEY = "fs_token";

/** Try to restore a saved token from Telegram CloudStorage. */
export async function restoreToken(): Promise<string | null> {
  return await cloudStorageGet(TOKEN_KEY);
}

/** Save token to Telegram CloudStorage. */
export async function saveToken(token: string): Promise<void> {
  await cloudStorageSet(TOKEN_KEY, token);
}

/**
 * Exchange a one-time pairing code for a session token.
 */
export async function exchangePairCode(pairCode: string): Promise<string> {
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
  const data = (await resp.json()) as { token: string };
  return data.token;
}
