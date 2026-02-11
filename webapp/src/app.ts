import { FilesApiClient } from "./services/files-api.js";
import { getTelegramWebApp } from "./services/telegram.js";
import { loadAndRenderFileList } from "./views/file-list.js";
import { renderFileEditor } from "./views/file-editor.js";

export function mountApp(container: HTMLElement, client: FilesApiClient): void {
  const webapp = getTelegramWebApp();
  let currentPath = "/";

  // Start at home directory or root
  showDir("/home");

  function showDir(dirPath: string) {
    currentPath = dirPath;
    webapp.BackButton.hide();
    webapp.MainButton.hide();

    // Show back button if not at root
    if (dirPath !== "/") {
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
