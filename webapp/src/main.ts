import { getTelegramWebApp } from "./services/telegram.js";
import { restoreToken, saveToken, exchangePairCode } from "./services/auth.js";
import { GatewayWsClient } from "./services/gateway-ws.js";
import { mountApp } from "./app.js";

async function main() {
  const app = document.getElementById("app")!;
  const webapp = getTelegramWebApp();

  // Signal Telegram that the app is ready
  webapp.ready();
  webapp.expand();

  showStatus(app, "Connecting...");

  try {
    const auth = await authenticate();
    showStatus(app, "Connecting to gateway...");

    const client = new GatewayWsClient(auth.token, auth.wsUrl);
    await client.connect();

    // Load agent list
    const agents = await client.listAgents();
    if (agents.length === 0) {
      showStatus(app, "No agents found. Create an agent first.", true);
      return;
    }

    app.innerHTML = "";
    await mountApp(app, {
      client,
      agentId: agents[0].id,
      agents,
    });
  } catch (err) {
    showStatus(app, `Connection failed: ${(err as Error).message}`, true);
  }
}

async function authenticate() {
  // 1. Try restoring saved token from CloudStorage
  const saved = await restoreToken();
  if (saved) return saved;

  // 2. Check URL for pairing code
  const url = new URL(window.location.href);
  const pairCode = url.searchParams.get("pair");

  if (!pairCode) {
    throw new Error("No saved token and no pairing code. Send /files in Telegram to get started.");
  }

  // 3. Exchange pairing code for token
  const auth = await exchangePairCode(pairCode);

  // 4. Save to CloudStorage for future sessions
  await saveToken(auth);

  // 5. Clean up URL (remove pair param)
  url.searchParams.delete("pair");
  window.history.replaceState({}, "", url.toString());

  return auth;
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
