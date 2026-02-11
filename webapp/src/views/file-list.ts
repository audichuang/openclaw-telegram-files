import type { FilesApiClient, FileItem } from "../services/files-api.js";

/** Render the directory listing view. */
export function renderFileList(params: {
  container: HTMLElement;
  currentPath: string;
  items: FileItem[];
  onNavigate: (path: string) => void;
  onFileOpen: (path: string) => void;
}): void {
  const { container, currentPath, items, onNavigate, onFileOpen } = params;
  container.innerHTML = "";

  // Breadcrumb / path display
  const header = document.createElement("div");
  header.className = "path-header";
  header.textContent = currentPath;
  container.appendChild(header);

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status-message";
    empty.textContent = "Empty directory";
    container.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "file-list";

  for (const item of items) {
    const el = document.createElement("div");
    el.className = "file-item";

    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = item.isDir ? "📁" : item.isSymlink ? "🔗" : getFileIcon(item.name);

    const name = document.createElement("div");
    name.className = "file-info";

    const nameText = document.createElement("div");
    nameText.className = "file-name";
    nameText.textContent = item.name;
    name.appendChild(nameText);

    el.appendChild(icon);
    el.appendChild(name);

    if (item.isDir) {
      el.addEventListener("click", () => {
        const newPath = currentPath === "/" ? `/${item.name}` : `${currentPath}/${item.name}`;
        onNavigate(newPath);
      });
    } else if (item.isFile) {
      const badge = document.createElement("span");
      badge.className = "file-badge exists";
      badge.textContent = "edit";
      el.appendChild(badge);
      el.addEventListener("click", () => {
        const filePath = currentPath === "/" ? `/${item.name}` : `${currentPath}/${item.name}`;
        onFileOpen(filePath);
      });
    }

    list.appendChild(el);
  }

  container.appendChild(list);
}

/** Load directory listing and render. */
export async function loadAndRenderFileList(params: {
  container: HTMLElement;
  client: FilesApiClient;
  dirPath: string;
  onNavigate: (path: string) => void;
  onFileOpen: (path: string) => void;
}): Promise<void> {
  const { container, client, dirPath, onNavigate, onFileOpen } = params;
  container.innerHTML = `<div class="status-message">Loading...</div>`;

  try {
    const result = await client.ls(dirPath);
    renderFileList({
      container,
      currentPath: result.path,
      items: result.items,
      onNavigate,
      onFileOpen,
    });
  } catch (err) {
    container.innerHTML = `<div class="status-message error-text">Failed: ${(err as Error).message}</div>`;
  }
}

function getFileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return "📝";
  if (lower.endsWith(".json") || lower.endsWith(".json5")) return "⚙️";
  if (lower.endsWith(".ts") || lower.endsWith(".js")) return "📜";
  if (lower.endsWith(".sh")) return "🐚";
  if (lower.endsWith(".log")) return "📋";
  if (lower.startsWith(".")) return "🔧";
  return "📄";
}
