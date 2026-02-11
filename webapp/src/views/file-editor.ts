import type { FilesApiClient } from "../services/files-api.js";
import type { TelegramWebApp } from "../services/telegram.js";

/** Render the file editor view. */
export function renderFileEditor(params: {
  container: HTMLElement;
  client: FilesApiClient;
  filePath: string;
  webapp: TelegramWebApp;
  onBack: () => void;
}): void {
  const { container, client, filePath, webapp, onBack } = params;
  container.innerHTML = "";

  const editorContainer = document.createElement("div");
  editorContainer.className = "editor-container";

  const header = document.createElement("div");
  header.className = "editor-header";

  const fileNameEl = document.createElement("span");
  fileNameEl.className = "editor-filename";
  // Show just the filename, full path in subtitle
  const parts = filePath.split("/");
  fileNameEl.textContent = parts[parts.length - 1] || filePath;

  const statusEl = document.createElement("span");
  statusEl.className = "editor-status";
  statusEl.textContent = "Loading...";

  header.appendChild(fileNameEl);
  header.appendChild(statusEl);

  const pathEl = document.createElement("div");
  pathEl.className = "file-meta";
  pathEl.style.padding = "0 0 8px";
  pathEl.textContent = filePath;

  const textarea = document.createElement("textarea");
  textarea.className = "editor-textarea";
  textarea.placeholder = "Loading...";
  textarea.disabled = true;
  textarea.spellcheck = false;

  editorContainer.appendChild(header);
  editorContainer.appendChild(pathEl);
  editorContainer.appendChild(textarea);
  container.appendChild(editorContainer);

  let originalContent = "";
  let dirty = false;

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
    if (dirty && !confirm("You have unsaved changes. Discard?")) return;
    cleanup();
    onBack();
  };
  webapp.BackButton.onClick(handleBack);

  // Save
  const handleSave = async () => {
    webapp.MainButton.showProgress(true);
    webapp.MainButton.disable();
    statusEl.textContent = "Saving...";

    try {
      await client.write(filePath, textarea.value);
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

  loadContent();

  async function loadContent() {
    try {
      const result = await client.read(filePath);
      originalContent = result.content;
      textarea.value = result.content;
      textarea.disabled = false;
      statusEl.textContent = "Ready";
    } catch (err) {
      statusEl.textContent = `Error: ${(err as Error).message}`;
      textarea.placeholder = "Failed to load file.";
    }
  }
}
