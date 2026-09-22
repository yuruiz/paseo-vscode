import type { PluginServerContext } from "@getpaseo/plugin/server";
import { connection, openEditor } from "./shared/contracts";
import { workspaceEditorUrl } from "./server/editor";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(connection);
  server.handle(openEditor, async ({ workspaceId, connection: config }, { paseo }) => {
    if (!config.editorUrl) {
      throw new Error("Configure the editor address in Settings → Plugins → VS Code.");
    }
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace) throw new Error("This workspace is no longer available.");
    return { url: workspaceEditorUrl(config.editorUrl, workspace.workspaceDirectory) };
  });
  return () => {};
}
