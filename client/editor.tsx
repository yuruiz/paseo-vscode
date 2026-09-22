import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  useRpc,
  useSettings,
  useWorkspace,
  type PluginWorkspacePanelProps,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { connection, openEditor } from "../shared/contracts";
import { EditorWebview } from "./web";

export function EditorPanel({ workspaceId, host, navigation, theme }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const launch = useRpc(openEditor);
  const settings = useSettings(connection);
  const editor = useQuery({
    queryKey: [
      "vscode-editor",
      host.id,
      workspaceId,
      settings.status === "ready" ? settings.revision : null,
    ],
    enabled: settings.status === "ready",
    queryFn: async () => {
      if (settings.status !== "ready") throw new Error("Editor settings are unavailable.");
      return launch({ workspaceId, connection: settings.values });
    },
    staleTime: Infinity,
    retry: false,
  });
  const styles = useMemo(
    () => ({
      panel: { padding: 16, gap: 12 },
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      button: { padding: 12, borderRadius: 6, backgroundColor: theme.colors.surface1 },
    }),
    [theme],
  );
  const open = useMutation({
    mutationFn: async () => {
      if (settings.status !== "ready")
        throw new Error("Editor settings are not available. Open Settings → Plugins → VS Code.");
      if (!editor.data) throw new Error("Editor is not ready.");
      await copyText(editor.data.url);
    },
  });
  const onOpen = useCallback(() => open.mutate(), [open]);
  const openExternal = useCallback(
    (url: string) => {
      navigation?.openBrowser?.({ workspaceId, url });
    },
    [navigation, workspaceId],
  );
  const retry = useCallback(() => {
    void settings.reload();
    void editor.refetch();
  }, [settings, editor]);
  let buttonLabel = "Copy VS Code link";
  if (open.isSuccess) buttonLabel = "Link copied";
  if (open.isPending) buttonLabel = "Opening…";
  if (editor.data && navigation?.openBrowser) {
    return <EditorWebview url={editor.data.url} theme={theme} openExternal={openExternal} />;
  }
  if (settings.status === "loading" || editor.isLoading)
    return <Text style={styles.text}>Opening VS Code…</Text>;
  if (settings.status !== "ready" || editor.error) {
    return (
      <View style={styles.panel}>
        <Text accessibilityRole="alert" style={styles.text}>
          {editor.error?.message ??
            (settings.status !== "ready" ? settings.error : "Editor settings are unavailable.")}
        </Text>
        <Pressable accessibilityRole="button" onPress={retry} style={styles.button}>
          <Text style={styles.text}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.panel}>
      <Text style={styles.text}>VS Code</Text>
      <Text style={styles.muted}>{directory}</Text>
      <Text style={styles.muted}>
        Open this workspace with files, editing, Git, search, and terminals.
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={open.isPending || !editor.data}
        onPress={onOpen}
        style={styles.button}
      >
        <Text style={styles.text}>{buttonLabel}</Text>
      </Pressable>
      {open.error ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {open.error.message}
        </Text>
      ) : null}
    </View>
  );
}

type ReadySettings = Extract<SettingsState<typeof connection.schema>, { status: "ready" }>;
function ConnectionEditor({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
}) {
  const [draft, setDraft] = useState<{ editorUrl: string; revision: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const text = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const change = useCallback(
    (editorUrl: string) => {
      setSaved(false);
      setDraft({ editorUrl, revision: draft?.revision ?? settings.revision });
    },
    [draft, settings.revision],
  );
  const save = useCallback(async () => {
    if (
      await settings.save(
        { editorUrl: draft?.editorUrl ?? settings.values.editorUrl },
        draft?.revision ?? settings.revision,
      )
    ) {
      setDraft(null);
      setSaved(true);
    }
  }, [draft, settings]);
  return (
    <SettingsSection title="Remote editor">
      <SettingsCard>
        <SettingsInput
          label="Editor URL"
          hint="The HTTPS editor address, including its connection token."
          initialValue={draft?.editorUrl ?? settings.values.editorUrl}
          secureTextEntry
          disabled={settings.saving}
          onChangeText={change}
        />
        <SettingsAction
          label="Connection"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={settings.saving}
          onPress={save}
        />
        {settings.saveError ? (
          <Text accessibilityRole="alert" style={text}>
            {settings.saveError}
          </Text>
        ) : null}
        {saved ? <Text style={text}>Connection saved.</Text> : null}
      </SettingsCard>
    </SettingsSection>
  );
}
export function ConnectionSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(connection);
  const text = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={text}>Loading…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Connection">
        <Text style={text}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
      </SettingsSection>
    );
  return <ConnectionEditor settings={settings} theme={theme} />;
}
