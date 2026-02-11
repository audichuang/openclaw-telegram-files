import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { setFilesRuntime } from "./src/runtime.js";
import { registerAll } from "./src/register.js";

const plugin = {
  id: "telegram-files",
  name: "Telegram File Manager",
  description:
    "Telegram Mini App for editing agent workspace files on mobile",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setFilesRuntime(api.runtime);
    registerAll(api);
  },
};

export default plugin;
