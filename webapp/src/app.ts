import { FilesApiClient } from "./services/files-api.js";
import { getTelegramWebApp } from "./services/telegram.js";
import { loadAndRenderFileList } from "./views/file-list.js";
import { renderFileEditor } from "./views/file-editor.js";

export function mountApp(container: HTMLElement, client: FilesApiClient): void {
  const webapp = getTelegramWebApp();
  let currentPath = "/";
  let homeDir = "/";

  // Check URL for a start path (from /files /some/path)
  const urlParams = new URLSearchParams(window.location.search);
  const startPath = urlParams.get("path");

  // DEBUG: show URL info on screen
  const dbg = document.createElement("div");
  dbg.style.cssText = "font-size:10px;color:#999;word-break:break-all;padding:8px;background:#f5f5f5;border-radius:4px;margin-bottom:8px;";
  dbg.textContent = `URL: ${window.location.href} | startPath: ${startPath ?? "null"}`;
  container.appendChild(dbg);

  // Ask the server for the default start directory
  client.home()
    .then((result) => {
      homeDir = result.path;
      showDir(startPath || result.path);
    })
    .catch(() => showDir(startPath || "/"));

  function showDir(dirPath: string) {
    currentPath = dirPath;
    webapp.BackButton.hide();
    webapp.MainButton.hide();

    // Show back button only if we're deeper than the home directory
    if (dirPath !== "/" && dirPath !== homeDir) {
      webapp.BackButton.show();
      const handleBack = () => {
        webapp.BackButton.offClick(handleBack);
        const parent = dirPath.substring(0, dirPath.lastIndexOf("/")) || "/";
        showDir(parent);
      };
      webapp.BackButton.onClick(handleBack);
    }

    loadAndRenderFileList({
      container,
      client,
      dirPath,
      homeDir,
      onNavigate: (path) => showDir(path),
      onFileOpen: (path) => showEditor(path),
    });
  }

  function showEditor(filePath: string) {
    renderFileEditor({
      container,
      client,
      filePath,
      webapp,
      onBack: () => showDir(currentPath),
    });
  }
}
