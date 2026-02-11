import type { FilesApiClient, FileItem, SearchResult } from "../services/files-api.js";

/** Format bytes to human-readable size. */
function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

/** Format mtime to relative or short date. */
function formatTime(mtimeMs: number): string {
  if (!mtimeMs) return "";
  const diff = Date.now() - mtimeMs;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(mtimeMs);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

/** Render the directory listing view. */
export function renderFileList(params: {
  container: HTMLElement;
  currentPath: string;
  items: FileItem[];
  client: FilesApiClient;
  onNavigate: (path: string) => void;
  onFileOpen: (path: string) => void;
  onRefresh: () => void;
}): void {
  const { container, currentPath, items, client, onNavigate, onFileOpen, onRefresh } = params;
  container.innerHTML = "";

  // --- Toolbar: path + hidden toggle ---
  const toolbar = document.createElement("div");
  toolbar.className = "list-toolbar";

  const header = document.createElement("div");
  header.className = "path-header";
  header.textContent = currentPath;

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "toggle-hidden-btn";
  const showHidden = localStorage.getItem("tgfiles-show-hidden") === "1";
  toggleBtn.textContent = showHidden ? "Hide .*" : "Show .*";
  toggleBtn.addEventListener("click", () => {
    const next = localStorage.getItem("tgfiles-show-hidden") === "1" ? "0" : "1";
    localStorage.setItem("tgfiles-show-hidden", next);
    onRefresh();
  });

  toolbar.appendChild(header);
  toolbar.appendChild(toggleBtn);
  container.appendChild(toolbar);

  // --- Search bar ---
  const searchBar = document.createElement("div");
  searchBar.className = "search-bar";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search files...";
  searchInput.className = "search-input";
  searchBar.appendChild(searchInput);
  container.appendChild(searchBar);

  // Search results container (hidden by default)
  const searchResults = document.createElement("div");
  searchResults.className = "search-results";
  searchResults.style.display = "none";
  container.appendChild(searchResults);

  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener("input", () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    const query = searchInput.value.trim();
    if (!query) {
      searchResults.style.display = "none";
      fileListEl.style.display = "";
      actionsBar.style.display = "";
      return;
    }
    searchTimeout = setTimeout(async () => {
      searchResults.innerHTML = `<div class="status-message">Searching...</div>`;
      searchResults.style.display = "";
      fileListEl.style.display = "none";
      actionsBar.style.display = "none";
      try {
        const resp = await client.search(currentPath, query);
        renderSearchResults(searchResults, resp.results, onNavigate, onFileOpen);
      } catch (err) {
        searchResults.innerHTML = `<div class="status-message error-text">Search failed: ${(err as Error).message}</div>`;
      }
    }, 300);
  });

  // --- File list ---
  const fileListEl = document.createElement("div");
  fileListEl.className = "file-list";

  // Filter hidden files
  const filteredItems = showHidden ? items : items.filter((i) => !i.name.startsWith("."));

  if (filteredItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status-message";
    empty.textContent = "Empty directory";
    fileListEl.appendChild(empty);
  } else {
    for (const item of filteredItems) {
      const el = document.createElement("div");
      el.className = "file-item";

      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.textContent = item.isDir ? "📁" : item.isSymlink ? "🔗" : getFileIcon(item.name);

      const info = document.createElement("div");
      info.className = "file-info";

      const nameText = document.createElement("div");
      nameText.className = "file-name";
      nameText.textContent = item.name;
      info.appendChild(nameText);

      // Show size + mtime for files
      if (item.isFile) {
        const meta = document.createElement("div");
        meta.className = "file-meta";
        const parts: string[] = [];
        if (item.size !== undefined) parts.push(formatSize(item.size));
        if (item.mtime) parts.push(formatTime(item.mtime));
        meta.textContent = parts.join(" · ");
        info.appendChild(meta);
      }

      el.appendChild(icon);
      el.appendChild(info);

      if (item.isDir) {
        el.addEventListener("click", () => {
          const newPath = currentPath === "/" ? `/${item.name}` : `${currentPath}/${item.name}`;
          onNavigate(newPath);
        });
      } else if (item.isFile) {
        // Delete button
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "item-delete-btn";
        deleteBtn.textContent = "🗑";
        deleteBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const filePath = currentPath === "/" ? `/${item.name}` : `${currentPath}/${item.name}`;
          if (!confirm(`Delete "${item.name}"?`)) return;
          try {
            await client.delete(filePath);
            onRefresh();
          } catch (err) {
            alert(`Delete failed: ${(err as Error).message}`);
          }
        });
        el.appendChild(deleteBtn);

        el.addEventListener("click", () => {
          const filePath = currentPath === "/" ? `/${item.name}` : `${currentPath}/${item.name}`;
          onFileOpen(filePath);
        });
      }

      // Directories also get a delete button
      if (item.isDir) {
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "item-delete-btn";
        deleteBtn.textContent = "🗑";
        deleteBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const dirPath = currentPath === "/" ? `/${item.name}` : `${currentPath}/${item.name}`;
          if (!confirm(`Delete folder "${item.name}" and all its contents?`)) return;
          try {
            await client.delete(dirPath);
            onRefresh();
          } catch (err) {
            alert(`Delete failed: ${(err as Error).message}`);
          }
        });
        el.appendChild(deleteBtn);
      }

      fileListEl.appendChild(el);
    }
  }

  container.appendChild(fileListEl);

  // --- Action buttons: New File + New Folder ---
  const actionsBar = document.createElement("div");
  actionsBar.className = "actions-bar";

  const newFileBtn = document.createElement("button");
  newFileBtn.className = "action-btn";
  newFileBtn.textContent = "+ New File";
  newFileBtn.addEventListener("click", () => {
    const name = prompt("Enter file name:");
    if (!name || !name.trim()) return;
    const filePath = currentPath === "/" ? `/${name.trim()}` : `${currentPath}/${name.trim()}`;
    onFileOpen(filePath);
  });

  const newFolderBtn = document.createElement("button");
  newFolderBtn.className = "action-btn";
  newFolderBtn.textContent = "+ New Folder";
  newFolderBtn.addEventListener("click", async () => {
    const name = prompt("Enter folder name:");
    if (!name || !name.trim()) return;
    const dirPath = currentPath === "/" ? `/${name.trim()}` : `${currentPath}/${name.trim()}`;
    try {
      await client.mkdir(dirPath);
      onRefresh();
    } catch (err) {
      alert(`Failed to create folder: ${(err as Error).message}`);
    }
  });

  actionsBar.appendChild(newFileBtn);
  actionsBar.appendChild(newFolderBtn);
  container.appendChild(actionsBar);
}

/** Render search results. */
function renderSearchResults(
  container: HTMLElement,
  results: SearchResult[],
  onNavigate: (path: string) => void,
  onFileOpen: (path: string) => void,
): void {
  container.innerHTML = "";
  if (results.length === 0) {
    container.innerHTML = `<div class="status-message">No results found</div>`;
    return;
  }

  for (const item of results) {
    const el = document.createElement("div");
    el.className = "file-item";

    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = item.isDir ? "📁" : getFileIcon(item.name);

    const info = document.createElement("div");
    info.className = "file-info";

    const nameText = document.createElement("div");
    nameText.className = "file-name";
    nameText.textContent = item.name;
    info.appendChild(nameText);

    const pathText = document.createElement("div");
    pathText.className = "file-meta";
    pathText.textContent = item.path;
    info.appendChild(pathText);

    el.appendChild(icon);
    el.appendChild(info);

    el.addEventListener("click", () => {
      if (item.isDir) {
        onNavigate(item.path);
      } else {
        onFileOpen(item.path);
      }
    });

    container.appendChild(el);
  }
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
      client,
      onNavigate,
      onFileOpen,
      onRefresh: () => loadAndRenderFileList(params),
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
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".svg")) return "🖼️";
  if (lower.endsWith(".zip") || lower.endsWith(".tar") || lower.endsWith(".gz")) return "📦";
  if (lower.startsWith(".")) return "🔧";
  return "📄";
}
