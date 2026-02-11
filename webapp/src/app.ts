import { GatewayWsClient } from "./services/gateway-ws.js";
import { getTelegramWebApp } from "./services/telegram.js";
import { loadAndRenderFileList } from "./views/file-list.js";
import { renderFileEditor } from "./views/file-editor.js";

export type AppState = {
  client: GatewayWsClient;
  agentId: string;
  agents: Array<{ id: string; name?: string }>;
};

/** Mount the app UI into the given container. */
export async function mountApp(container: HTMLElement, state: AppState): Promise<void> {
  const webapp = getTelegramWebApp();

  // If multiple agents, show agent selector
  if (state.agents.length > 1) {
    const selector = document.createElement("div");
    selector.className = "agent-selector";

    for (const agent of state.agents) {
      const chip = document.createElement("button");
      chip.className = `agent-chip ${agent.id === state.agentId ? "active" : ""}`;
      chip.textContent = agent.name ?? agent.id;
      chip.addEventListener("click", () => {
        state.agentId = agent.id;
        // Update active chip
        selector.querySelectorAll(".agent-chip").forEach((el) => el.classList.remove("active"));
        chip.classList.add("active");
        showFileList();
      });
      selector.appendChild(chip);
    }

    container.appendChild(selector);
  }

  const viewContainer = document.createElement("div");
  viewContainer.style.flex = "1";
  viewContainer.style.display = "flex";
  viewContainer.style.flexDirection = "column";
  container.appendChild(viewContainer);

  showFileList();

  function showFileList() {
    webapp.BackButton.hide();
    webapp.MainButton.hide();
    loadAndRenderFileList({
      container: viewContainer,
      client: state.client,
      agentId: state.agentId,
      onFileClick: (name) => showEditor(name),
    });
  }

  function showEditor(fileName: string) {
    renderFileEditor({
      container: viewContainer,
      client: state.client,
      agentId: state.agentId,
      fileName,
      webapp,
      onBack: () => showFileList(),
    });
  }
}
