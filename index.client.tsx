import type { PluginClientContext } from "@getpaseo/plugin/client";
import { EditorPanel, ConnectionSettings } from "./client/editor";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "review",
    title: "VS Code",
    icon: "Code",
    context: "workspace",
    locations: ["workspace"],
    Component: EditorPanel,
  });
  client.addSettingsScreen({
    id: "connection",
    title: "VS Code",
    icon: "Code",
    Component: ConnectionSettings,
  });
  client.addCommandCenterItem({
    id: "open-review",
    title: "Open VS Code",
    icon: "Code",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("review", { location: "workspace" });
    },
  });
  return () => {};
}
