import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const connection = defineSettings({
  id: "connection",
  scope: "host",
  version: 1,
  schema: z.object({ editorUrl: z.string().default("") }),
});

export const openEditor = defineRpc({
  name: "editor.open",
  input: z.object({ workspaceId: z.string().min(1), connection: connection.schema }),
  output: z.object({ url: z.string() }),
});
