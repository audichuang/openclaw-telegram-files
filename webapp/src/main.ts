import { getTelegramWebApp } from "./services/telegram.js";
import { restoreToken, saveToken, clearToken, exchangePairCode } from "./services/auth.js";
import { FilesApiClient } from "./services/files-api.js";
import { mountApp } from "./app.js";

async function main() {
  const app = document.getElementById("app")!;
  const webapp = getTelegramWebApp();

  webapp.ready();
  webapp.expand();

  showStatus(app, "Connecting...");

  try {
    const token = await authenticate();
    showStatus(app, "Loading...");

    const client = new FilesApiClient(token);

    // Quick validation: try fetching home directory
    await client.home();

    app.innerHTML = "";
    mountApp(app, client);
  } catch (err) {
    showStatus(app, `Connection failed: ${(err as Error).message}`, true);
  }
}

async function authenticate(): Promise<string> {
  // 1. Try saved token (may fail if CloudStorage is unavailable)
  try {
    const saved = await restoreToken();
    if (saved) {
      // Validate token is still active on server
      const client = new FilesApiClient(saved);
      try {
        await client.home();
        return saved;
      } catch {
        // Token invalid (server restarted?) — clear and continue
        try { await clearToken(); } catch { /* ignore */ }
      }
    }
  } catch {
    // CloudStorage not available — continue to pairing
  }

  // 2. Check URL for pairing code
  const url = new URL(window.location.href);
  const pairCode = url.searchParams.get("pair");

  if (!pairCode) {
    throw new Error("No saved token. Send /files in Telegram to get started.");
  }

  // 3. Exchange
  const token = await exchangePairCode(pairCode);

  // 4. Save (best-effort, don't fail if CloudStorage unavailable)
  try {
    await saveToken(token);
  } catch {
    // CloudStorage not available — token won't persist across sessions
  }

  // 5. Clean URL
  url.searchParams.delete("pair");
  window.history.replaceState({}, "", url.toString());

  return token;
}

function showStatus(container: HTMLElement, message: string, isError = false) {
  container.innerHTML = `<div class="status-message ${isError ? "error-text" : ""}">${escapeHtml(message)}</div>`;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

main();
