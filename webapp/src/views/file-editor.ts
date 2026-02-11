import type { GatewayWsClient } from "../services/gateway-ws.js";
import type { TelegramWebApp } from "../services/telegram.js";

/** Render the file editor view. */
export function renderFileEditor(params: {
  container: HTMLElement;
  client: GatewayWsClient;
  agentId: string;
  fileName: string;
  webapp: TelegramWebApp;
  onBack: () => void;
}): void {
  const { container, client, agentId, fileName, webapp, onBack } = params;
  container.innerHTML = "";

  const editorContainer = document.createElement("div");
  editorContainer.className = "editor-container";

  // Header
  const header = document.createElement("div");
  header.className = "editor-header";

  const fileNameEl = document.createElement("span");
  fileNameEl.className = "editor-filename";
  fileNameEl.textContent = fileName;

  const statusEl = document.createElement("span");
  statusEl.className = "editor-status";
  statusEl.textContent = "Loading...";

  header.appendChild(fileNameEl);
  header.appendChild(statusEl);

  // Textarea
  const textarea = document.createElement("textarea");
  textarea.className = "editor-textarea";
  textarea.placeholder = "Loading file content...";
  textarea.disabled = true;
  textarea.spellcheck = false;

  editorContainer.appendChild(header);
  editorContainer.appendChild(textarea);
  container.appendChild(editorContainer);

  let originalContent = "";
  let dirty = false;

  // Track unsaved changes
  textarea.addEventListener("input", () => {
    const isDirty = textarea.value !== originalContent;
    if (isDirty !== dirty) {
      dirty = isDirty;
      statusEl.textContent = dirty ? "Modified" : "Saved";
      if (dirty) {
        webapp.MainButton.setText("Save");
        webapp.MainButton.show();
      } else {
        webapp.MainButton.hide();
      }
    }
  });

  // Back button
  webapp.BackButton.show();
  const handleBack = () => {
    if (dirty) {
      // Simple confirm via native dialog (Telegram supports this)
      if (!confirm("You have unsaved changes. Discard?")) return;
    }
    cleanup();
    onBack();
  };
  webapp.BackButton.onClick(handleBack);

  // Save via MainButton
  const handleSave = async () => {
    webapp.MainButton.showProgress(true);
    webapp.MainButton.disable();
    statusEl.textContent = "Saving...";

    try {
      await client.setFile(agentId, fileName, textarea.value);
      originalContent = textarea.value;
      dirty = false;
      statusEl.textContent = "Saved";
      webapp.MainButton.hide();
    } catch (err) {
      statusEl.textContent = `Error: ${(err as Error).message}`;
    } finally {
      webapp.MainButton.hideProgress();
      webapp.MainButton.enable();
    }
  };
  webapp.MainButton.onClick(handleSave);

  function cleanup() {
    webapp.BackButton.hide();
    webapp.BackButton.offClick(handleBack);
    webapp.MainButton.hide();
    webapp.MainButton.offClick(handleSave);
  }

  // Load file content
  loadContent();

  async function loadContent() {
    try {
      const content = await client.getFile(agentId, fileName);
      originalContent = content;
      textarea.value = content;
      textarea.disabled = false;
      statusEl.textContent = content ? "Ready" : "New file";
    } catch (err) {
      statusEl.textContent = `Error: ${(err as Error).message}`;
      textarea.placeholder = "Failed to load file content.";
    }
  }
}
