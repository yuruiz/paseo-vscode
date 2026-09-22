import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createServer } from "node:net";
import { fixWebviewEndpoint } from "./fix-webview.mjs";
import { fixSecretStorage } from "./fix-secret-storage.mjs";

const { values } = parseArgs({
  options: {
    binary: { type: "string" },
    data: { type: "string" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "19888" },
    "public-url": { type: "string" },
  },
});
if (!values.binary || !values.data || !path.isAbsolute(values.data) || !values["public-url"]) {
  throw new Error(
    "Usage: node scripts/start.mjs --binary /path/to/openvscode-server --data /data/path --public-url https://editor.example.com [--host 127.0.0.1] [--port 19888]",
  );
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(port, values.host, () => probe.close(resolve));
});
const publicUrl = new URL(values["public-url"]);
if (!["https:", "http:"].includes(publicUrl.protocol))
  throw new Error("Use an HTTP(S) public URL.");
await mkdir(values.data, { recursive: true, mode: 0o700 });
const data = await realpath(values.data);
for (const name of ["tmp", "cache", "server", "user", "extensions"]) {
  await mkdir(path.join(data, name), { recursive: true, mode: 0o700 });
}
const tokenFile = path.join(data, "connection-token");
try {
  await writeFile(tokenFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
publicUrl.searchParams.set("tkn", (await readFile(tokenFile, "utf8")).trim());
await writeFile(
  path.join(data, "connection.json"),
  JSON.stringify(
    {
      editorUrl: publicUrl.href,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`Plugin connection settings written to ${path.join(data, "connection.json")}`);
if (await fixWebviewEndpoint(values.binary)) {
  console.log("Updated OpenVSCode 1.109.5 webview assets to match the editor version.");
}
if (await fixSecretStorage(values.binary)) {
  console.log("Enabled shared encrypted credential storage for remote extensions.");
}
const child = spawn(
  values.binary,
  [
    "--host",
    values.host,
    "--port",
    String(port),
    "--connection-token-file",
    tokenFile,
    "--server-data-dir",
    path.join(data, "server"),
    "--user-data-dir",
    path.join(data, "user"),
    "--extensions-dir",
    path.join(data, "extensions"),
    "--telemetry-level",
    "off",
    "--reconnection-grace-time",
    "300",
  ],
  {
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      TMPDIR: path.join(data, "tmp"),
      XDG_CACHE_HOME: path.join(data, "cache"),
      VSCODE_AGENT_FOLDER: path.join(data, "server"),
      PASEO_VSCODE_SECRET_STORAGE: path.join(data, "user", "secret-storage"),
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => {
    if (process.platform === "win32" || !child.pid) child.kill(signal);
    else {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  });
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
