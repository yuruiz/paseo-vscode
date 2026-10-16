import type { PluginClientContext } from "@getpaseo/plugin/client";
import { disposeEditors } from "./client/web";
import { EditorPanel, ConnectionSettings } from "./client/editor";
import { SessionsScreen } from "./client/sessions";

export default function contribute(client: PluginClientContext) {
  const openEditor = (workspaceId: string) =>
    client.openPanel("review", { workspaceId, location: "workspace" });
  client.addSurface("sessions", (props) => (
    <SessionsScreen key={props.host.id} {...props} openEditor={openEditor} />
  ));
  client.addSidebarItem({
    id: "sessions",
    title: "VS Code sessions",
    icon: "Code",
    surface: "sessions",
  });
  client.addCommandCenterItem({
    id: "manage-sessions",
    title: "Manage VS Code sessions",
    icon: "Code",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("sessions");
    },
  });
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
  return disposeEditors;
}
