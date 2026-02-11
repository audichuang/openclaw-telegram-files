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
    const msg = (err as Error).message;
    if (msg.includes("No saved token") || msg.includes("unauthorized") || msg.includes("expired")) {
      showExpiredUI(app, webapp);
    } else {
      showStatus(app, `Connection failed: ${msg}`, true);
    }
  }
}

async function authenticate(): Promise<string> {
  // 1. Check URL for pairing code FIRST (fresh code takes priority)
  const url = new URL(window.location.href);
  const pairCode = url.searchParams.get("pair");

  if (pairCode) {
    try {
      const token = await exchangePairCode(pairCode);

      // Save (best-effort)
      try { await saveToken(token); } catch { /* CloudStorage unavailable */ }

      return token;
    } catch {
      // Pairing code already used or expired — fall through to saved token
    }
  }

  // 2. Try saved token
  try {
    const saved = await restoreToken();
    if (saved) {
      // Validate token is still active on server
      const client = new FilesApiClient(saved);
      try {
        await client.home();
        return saved;
      } catch {
        // Token invalid (server restarted / expired) — clear and continue
        try { await clearToken(); } catch { /* ignore */ }
      }
    }
  } catch {
    // CloudStorage not available
  }

  throw new Error("No saved token. Send /files in Telegram to get started.");
}

/** Show a friendly UI when the session has expired. */
function showExpiredUI(container: HTMLElement, webapp: TelegramWebApp) {
  container.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "status-message";

  const icon = document.createElement("div");
  icon.style.fontSize = "48px";
  icon.style.marginBottom = "12px";
  icon.textContent = "🔑";

  const title = document.createElement("div");
  title.style.fontWeight = "600";
  title.style.fontSize = "16px";
  title.style.marginBottom = "8px";
  title.textContent = "Session Expired";

  const desc = document.createElement("div");
  desc.style.marginBottom = "16px";
  desc.textContent = "Send /files in Telegram to get a new link.";

  const closeBtn = document.createElement("button");
  closeBtn.style.cssText = "padding:10px 24px;border-radius:8px;border:none;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);font-size:14px;font-weight:600;cursor:pointer;";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => webapp.close());

  wrapper.appendChild(icon);
  wrapper.appendChild(title);
  wrapper.appendChild(desc);
  wrapper.appendChild(closeBtn);
  container.appendChild(wrapper);
}

function showStatus(container: HTMLElement, message: string, isError = false) {
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = `status-message ${isError ? "error-text" : ""}`;
  div.textContent = message;
  container.appendChild(div);
}

// Import type for webapp
import type { TelegramWebApp } from "./services/telegram.js";

main();
