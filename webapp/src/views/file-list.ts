import type { FilesApiClient, FileItem, SearchResult } from "../services/files-api.js";

/** Format bytes to human-readable size. */
function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
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
  homeDir: string;
  onNavigate: (path: string) => void;
  onFileOpen: (path: string) => void;
  onRefresh: () => void;
}): void {
  const { container, currentPath, items, client, homeDir, onNavigate, onFileOpen, onRefresh } = params;
  container.innerHTML = "";

  // --- Toolbar: path + hidden toggle ---
  const toolbar = document.createElement("div");
  toolbar.className = "list-toolbar";

  const header = document.createElement("div");
  header.className = "path-header";

  // Build clickable breadcrumb segments
  const segments = currentPath.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "breadcrumb-sep";
      sep.textContent = " / ";
      header.appendChild(sep);
    }
    const segPath = "/" + segments.slice(0, i + 1).join("/");
    const link = document.createElement("span");
    link.textContent = segments[i];
    if (i === segments.length - 1) {
      // Current segment — not clickable
      link.className = "breadcrumb-current";
    } else if (segPath.length >= homeDir.length && segPath.startsWith(homeDir)) {
      // Within or equal to homeDir — clickable
      link.className = "breadcrumb-link";
      link.addEventListener("click", () => onNavigate(segPath));
    } else {
      // Above homeDir — not clickable (would be 403)
      link.className = "breadcrumb-disabled";
    }
    header.appendChild(link);
  }
  if (segments.length === 0) {
    header.textContent = "/";
  }

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
  let searchGeneration = 0;
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
      const thisGeneration = ++searchGeneration;
      searchResults.innerHTML = "";
      const loadingMsg = document.createElement("div");
      loadingMsg.className = "status-message";
      loadingMsg.textContent = "Searching...";
      searchResults.appendChild(loadingMsg);
      searchResults.style.display = "";
      fileListEl.style.display = "none";
      actionsBar.style.display = "none";
      try {
        const resp = await client.search(currentPath, query);
        if (thisGeneration !== searchGeneration) return; // stale, discard
        renderSearchResults(searchResults, resp.results, onNavigate, onFileOpen);
      } catch (err) {
        if (thisGeneration !== searchGeneration) return;
        searchResults.innerHTML = "";
        const errMsg = document.createElement("div");
        errMsg.className = "status-message error-text";
        errMsg.textContent = `Search failed: ${(err as Error).message}`;
        searchResults.appendChild(errMsg);
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
    const trimmed = name.trim();
    if (trimmed.includes("/") || trimmed.includes("\0")) {
      alert("File name cannot contain '/' or null characters.");
      return;
    }
    const filePath = currentPath === "/" ? `/${trimmed}` : `${currentPath}/${trimmed}`;
    onFileOpen(filePath);
  });

  const newFolderBtn = document.createElement("button");
  newFolderBtn.className = "action-btn";
  newFolderBtn.textContent = "+ New Folder";
  newFolderBtn.addEventListener("click", async () => {
    const name = prompt("Enter folder name:");
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (trimmed.includes("/") || trimmed.includes("\0")) {
      alert("Folder name cannot contain '/' or null characters.");
      return;
    }
    const dirPath = currentPath === "/" ? `/${trimmed}` : `${currentPath}/${trimmed}`;
    try {
      await client.mkdir(dirPath);
      onRefresh();
    } catch (err) {
      alert(`Failed to create folder: ${(err as Error).message}`);
    }
  });

  const uploadBtn = document.createElement("button");
  uploadBtn.className = "action-btn";
  uploadBtn.textContent = "↑ Upload";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.style.display = "none";
  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const files = fileInput.files;
    if (!files || files.length === 0) return;
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading...";
    let failed = 0;
    for (const file of Array.from(files)) {
      try {
        await client.upload(currentPath, file);
      } catch (err) {
        failed++;
        alert(`Upload failed (${file.name}): ${(err as Error).message}`);
      }
    }
    uploadBtn.disabled = false;
    uploadBtn.textContent = "↑ Upload";
    fileInput.value = "";
    onRefresh();
  });

  actionsBar.appendChild(newFileBtn);
  actionsBar.appendChild(newFolderBtn);
  actionsBar.appendChild(uploadBtn);
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
    const noResults = document.createElement("div");
    noResults.className = "status-message";
    noResults.textContent = "No results found";
    container.appendChild(noResults);
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
  homeDir: string;
  onNavigate: (path: string) => void;
  onFileOpen: (path: string) => void;
}): Promise<void> {
  const { container, client, dirPath, homeDir, onNavigate, onFileOpen } = params;
  container.innerHTML = "";
  const loadingMsg = document.createElement("div");
  loadingMsg.className = "status-message";
  loadingMsg.textContent = "Loading...";
  container.appendChild(loadingMsg);

  try {
    const result = await client.ls(dirPath);
    renderFileList({
      container,
      currentPath: result.path,
      items: result.items,
      client,
      homeDir,
      onNavigate,
      onFileOpen,
      onRefresh: () => loadAndRenderFileList(params),
    });
  } catch (err) {
    container.innerHTML = "";
    const errMsg = document.createElement("div");
    errMsg.className = "status-message error-text";
    errMsg.textContent = `Failed: ${(err as Error).message}`;
    container.appendChild(errMsg);
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
