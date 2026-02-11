import crypto from "node:crypto";

const store = new Map<string, { token: string; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
    }
  }
}

/** Create a one-time pairing code that maps to a gateway auth token. */
export function createPairingCode(gatewayToken: string): string {
  evictExpired();
  const code = crypto.randomBytes(32).toString("hex");
  store.set(code, { token: gatewayToken, expiresAt: Date.now() + TTL_MS });
  return code;
}

/** Exchange a pairing code for the gateway token. One-time use. */
export function exchangePairingCode(code: string): string | null {
  evictExpired();
  const entry = store.get(code);
  if (!entry) return null;
  store.delete(code);
  return entry.token;
}
