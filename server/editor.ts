export function workspaceEditorUrl(editorUrl: string, directory: string) {
  const url = new URL(editorUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP(S) editor address without embedded username/password.");
  }
  url.searchParams.delete("workspace");
  url.searchParams.set("folder", directory);
  return url.href;
}
