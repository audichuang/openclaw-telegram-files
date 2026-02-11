import type { GatewayWsClient, FileEntry } from "../services/gateway-ws.js";

/** Render the file list view into a container element. */
export function renderFileList(params: {
  container: HTMLElement;
  files: FileEntry[];
  agentId: string;
  onFileClick: (name: string) => void;
}): void {
  const { container, files, agentId, onFileClick } = params;
  container.innerHTML = "";

  const header = document.createElement("h1");
  header.className = "page-header";
  header.textContent = `Files`;
  container.appendChild(header);

  const agentLabel = document.createElement("div");
  agentLabel.className = "file-meta";
  agentLabel.style.paddingBottom = "8px";
  agentLabel.textContent = `Agent: ${agentId}`;
  container.appendChild(agentLabel);

  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status-message";
    empty.innerHTML = `<span class="emoji">📂</span>No files found for this agent.`;
    container.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "file-list";

  for (const file of files) {
    const item = document.createElement("div");
    item.className = "file-item";
    item.addEventListener("click", () => onFileClick(file.name));

    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = getFileIcon(file.name);

    const info = document.createElement("div");
    info.className = "file-info";

    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = file.name;

    const meta = document.createElement("div");
    meta.className = "file-meta";
    meta.textContent = file.sizeBytes != null ? formatBytes(file.sizeBytes) : "";

    info.appendChild(name);
    info.appendChild(meta);

    const badge = document.createElement("span");
    badge.className = `file-badge ${file.exists ? "exists" : "missing"}`;
    badge.textContent = file.exists ? "exists" : "create";

    item.appendChild(icon);
    item.appendChild(info);
    item.appendChild(badge);
    list.appendChild(item);
  }

  container.appendChild(list);
}

/** Load files from gateway and render. */
export async function loadAndRenderFileList(params: {
  container: HTMLElement;
  client: GatewayWsClient;
  agentId: string;
  onFileClick: (name: string) => void;
}): Promise<void> {
  const { container, client, agentId, onFileClick } = params;

  container.innerHTML = `<div class="status-message">Loading files...</div>`;

  try {
    const files = await client.listFiles(agentId);
    renderFileList({ container, files, agentId, onFileClick });
  } catch (err) {
    container.innerHTML = `<div class="status-message error-text">Failed to load files: ${(err as Error).message}</div>`;
  }
}

function getFileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return "📝";
  if (lower.includes("soul")) return "🧠";
  if (lower.includes("tool")) return "🔧";
  if (lower.includes("config")) return "⚙️";
  if (lower.includes("memory")) return "💾";
  return "📄";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
