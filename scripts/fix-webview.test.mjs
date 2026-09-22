import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { fixWebviewEndpoint } from "./fix-webview.mjs";
import { fixSecretStorage } from "./fix-secret-storage.mjs";

const roots = [];
const oldEndpoint =
  "https://{{uuid}}.vscode-cdn.net/insider/ef65ac1ba57f57f2a3961bfe94aa20481caca4c6/out/vs/workbench/contrib/webview/browser/pre/";
const bundle = "out/vs/code/browser/workbench/workbench.js";
const host = "out/vs/workbench/api/node/extensionHostProcess.js";
const html = "out/vs/code/browser/workbench/workbench.html";

async function runtime(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-webview-"));
  roots.push(root);
  const files = {
    "bin/openvscode-server": "",
    "product.json": JSON.stringify({
      version: "1.109.5",
      commit: "072586267e68ece9a47aa43f8c108e0dcbf44622",
      webviewContentExternalBaseUrlTemplate: oldEndpoint,
      ...overrides,
    }),
    "out/server-main.js": JSON.stringify(oldEndpoint),
    [bundle]: JSON.stringify(oldEndpoint),
    [host]: "this.a=e.getProxy(Q.MainThreadSecretState)",
    [html]: `<script type="module" src="{{WORKBENCH_WEB_BASE_URL}}/${bundle}"></script>`,
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return { root, binary: path.join(root, "bin/openvscode-server"), files };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("repairs the matching release and invalidates cached bundles without overwriting backups", async () => {
  const { root, binary, files } = await runtime();
  expect(await fixWebviewEndpoint(binary)).toBe(true);
  const source = await readFile(path.join(root, bundle), "utf8");
  expect(source).toContain(
    "https://{{uuid}}.vscode-cdn.net/stable/072586267e68ece9a47aa43f8c108e0dcbf44622/",
  );
  expect(source).not.toContain("ef65ac1ba57f57f2a3961bfe94aa20481caca4c6");
  expect(await readFile(path.join(root, html), "utf8")).toContain("?paseo-webview=1.109.5");
  expect(await fixWebviewEndpoint(binary)).toBe(false);
  expect(await readFile(path.join(root, `${bundle}.paseo-webview-original`), "utf8")).toBe(
    files[bundle],
  );
});

it.each([
  { version: "1.110.0" },
  { webviewContentExternalBaseUrlTemplate: "https://custom.test/" },
])("leaves other versions and custom endpoints untouched: %j", async (overrides) => {
  const { root, binary, files } = await runtime(overrides);
  expect(await fixWebviewEndpoint(binary)).toBe(false);
  expect(await readFile(path.join(root, bundle), "utf8")).toBe(files[bundle]);
});

it("rejects unexpected bundles before changing any runtime files", async () => {
  const { root, binary, files } = await runtime();
  await writeFile(path.join(root, bundle), "unexpected build");
  await expect(fixWebviewEndpoint(binary)).rejects.toThrow("runtime was not patched");
  expect(await readFile(path.join(root, "product.json"), "utf8")).toBe(files["product.json"]);
  expect(await readFile(path.join(root, "out/server-main.js"), "utf8")).toBe(
    files["out/server-main.js"],
  );
});

it("installs persistent secrets alongside the webview repair and remains idempotent on startup", async () => {
  const { root, binary } = await runtime();
  expect(await fixWebviewEndpoint(binary)).toBe(true);
  expect(await fixSecretStorage(binary)).toBe(true);
  const source = await readFile(path.join(root, host), "utf8");
  expect(source).toContain("this.a=paseoCreateRemoteSecretStorage(e=>this.b.fire(e))");
  const moduleName = source.match(/\.\/(paseo-secret-storage\.[a-f0-9]+\.mjs)/)[1];
  expect(await readFile(path.join(root, path.dirname(host), moduleName), "utf8")).toContain(
    "aes-256-gcm",
  );
  expect(await readFile(path.join(root, html), "utf8")).toContain("?paseo-webview=1.109.5");
  expect(await fixWebviewEndpoint(binary)).toBe(false);
  expect(await fixSecretStorage(binary)).toBe(false);
});

it("refuses unknown secret storage wiring before mutating the runtime", async () => {
  const { root, binary, files } = await runtime();
  await writeFile(path.join(root, host), "unknown version of entrypoint");
  await expect(fixSecretStorage(binary)).rejects.toThrow("runtime was not patched");
  expect(await readFile(path.join(root, html), "utf8")).toBe(files[html]);
});
