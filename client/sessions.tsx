import { useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  getEditorSessions,
  releaseEditor,
  subscribeEditorSessions,
  type EditorSession,
} from "./web";

export function SessionsScreen({
  theme,
  host,
  layout,
  openEditor,
}: PluginSurfaceProps & {
  openEditor(workspaceId: string): void;
}) {
  const allSessions = useSyncExternalStore(
    subscribeEditorSessions,
    getEditorSessions,
    getEditorSessions,
  );
  const sessions = allSessions.filter((session) => session.hostId === host.id);
  const [pending, setPending] = useState<readonly EditorSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  const button = (label: string, onPress: () => void, accessibilityLabel = label) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 6,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
  const open = (session: EditorSession) => {
    setError(null);
    try {
      openEditor(session.workspaceId);
    } catch {
      setError(
        "Could not open this workspace. It may have been removed; you can still release its session.",
      );
    }
  };
  const confirm = () => {
    for (const session of pending ?? []) releaseEditor(session.sessionKey, session.instanceId);
    setPending(null);
  };
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}
    >
      <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={{ ...text, fontSize: 24, fontWeight: "600" }}>
          VS Code sessions
        </Text>
        <Text style={muted}>
          {sessions.length} active · {host.label} · This client
        </Text>
        <Text style={muted}>
          Includes editors kept in the background after switching or closing tabs. Other clients'
          sessions are not listed.
        </Text>
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={text}>
          {error}
        </Text>
      ) : null}
      {pending ? (
        <View
          style={{ gap: 12, padding: 16, borderRadius: 8, backgroundColor: theme.colors.surface1 }}
        >
          <Text accessibilityRole="alert" style={text}>
            {pending.length === 1
              ? `Release “${pending[0].name}”?`
              : `Release these ${pending.length} sessions?`}{" "}
            Save your edits first. Unsaved changes may be lost. This closes the editor pages; it
            does not stop the remote editor server.
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {button("Cancel", () => setPending(null))}
            {button("Confirm release", confirm)}
          </View>
        </View>
      ) : sessions.length > 0 ? (
        <View style={{ alignItems: "flex-start" }}>
          {button("Release all…", () => setPending(sessions))}
        </View>
      ) : null}
      {sessions.length === 0 ? (
        <View style={{ paddingVertical: 24, gap: 8 }}>
          <Text style={text}>No active VS Code sessions</Text>
          <Text style={muted}>
            Open a workspace and choose + → VS Code in the desktop client. Its session will appear
            here.
          </Text>
        </View>
      ) : (
        sessions.map((session) => (
          <View
            key={session.instanceId}
            style={{
              gap: 12,
              paddingVertical: 16,
              borderTopWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <View
              style={{
                flexDirection: layout.compact ? "column" : "row",
                gap: 12,
                alignItems: layout.compact ? "stretch" : "center",
              }}
            >
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={{ ...text, fontSize: 16, fontWeight: "600" }}>{session.name}</Text>
                <Text selectable style={muted}>
                  {session.directory || session.workspaceId}
                </Text>
                <Text style={muted}>
                  {session.failed ? "Load failed" : session.visible ? "Visible" : "Background"}
                  {session.popupFailed ? " · Login windows unavailable" : ""}
                  {` · Last active ${new Date(session.lastActiveAt).toLocaleString()}`}
                </Text>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {button("Open editor", () => open(session), `Open editor for ${session.name}`)}
                {button("Release…", () => setPending([session]), `Release ${session.name}`)}
              </View>
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}
