// Runs the production session manager with real Electron webviews. Supply an
// Electron binary and a display; all generated files live under PASEO_TEST_ROOT.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import ts from "typescript";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.resolve(process.env.PASEO_TEST_ROOT || path.join(root, ".dev/retention"));
const executablePath = process.env.PASEO_ELECTRON_PATH;
assert.ok(executablePath, "Set PASEO_ELECTRON_PATH to your Electron executable");
await mkdir(output, { recursive: true });
await mkdir(path.join(output, "tmp"), { recursive: true });
const compiled = ts.transpileModule(await readFile(path.join(root, "client/web.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const main = path.join(output, "main.cjs");
await writeFile(
  main,
  `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(output, "user-data"))});
app.setPath('crashDumps', ${JSON.stringify(path.join(output, "crash-dumps"))});
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  const win = new BrowserWindow({ width: 1100, height: 850, show: false,
    webPreferences: { webviewTag: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html,' + encodeURIComponent('<style>body {margin:0} #slot {position:fixed;left:100px;top:90px;width:800px;height:600px}</style><input id="host" aria-label="Host composer"><div id="slot"></div>'));
  win.showInactive();
});
`,
);
let requests = 0;
const server = createServer((request, response) => {
  if (request.url !== "/editor") {
    response.writeHead(404).end();
    return;
  }
  requests++;
  response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  response.end(
    '<!doctype html><textarea id="draft" style="width:400px;height:200px"></textarea><script>window.sessionMarker = "original-page"</script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const editorUrl = `http://127.0.0.1:${server.address().port}/editor`;
let app;
const results = [];
try {
  app = await electron.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-gpu", main],
    env: {
      ...process.env,
      TMPDIR: path.join(output, "tmp"),
      XDG_CACHE_HOME: path.join(output, "cache"),
      XDG_CONFIG_HOME: path.join(output, "config"),
    },
    timeout: 20000,
  });
  const page = await app.firstWindow({ timeout: 15000 });
  await page.evaluate(
    ({ compiled, editorUrl }) => {
      const module = { exports: {} };
      // The manager uses real DOM and Electron guests; React is unused here.
      // The sole runtime shim identifies the host platform as web.
      new Function("require", "module", "exports", compiled)(
        (name) => {
          if (name === "react-native") return { Platform: { OS: "web" } };
          if (name === "react") return {};
          throw new Error(`Unexpected runtime import: ${name}`);
        },
        module,
        module.exports,
      );
      window.retention = module.exports;
      window.bind = () => {
        const anchor = document.createElement("div");
        anchor.style.cssText = "width:100%;height:100%";
        document.querySelector("#slot").appendChild(anchor);
        window.anchor = anchor;
        window.lease = window.retention.attachEditor({
          sessionKey: "fixture-workspace",
          url: editorUrl,
          anchor,
          openExternal: () => {},
          onStatus: (status) => {
            window.editorStatus = status;
          },
        });
      };
      window.bind();
    },
    { compiled, editorUrl },
  );
  await page.waitForFunction(
    async () => {
      try {
        return await document
          .querySelector("webview")
          .executeJavaScript('Boolean(document.querySelector("#draft"))');
      } catch {
        return false;
      }
    },
    { timeout: 15000 },
  );
  const original = await page.evaluate(async () => {
    const guest = document.querySelector("webview");
    window.originalGuest = guest;
    window.originalParent = guest.parentElement;
    await guest.executeJavaScript(
      `const draft = document.querySelector('#draft'); draft.value = 'unsaved\\n'.repeat(200); draft.selectionStart = 12; draft.selectionEnd = 18; draft.scrollTop = 300; window.sessionMarker = 'edited-page';`,
    );
    return {
      id: guest.getWebContentsId(),
      state: await guest.executeJavaScript(
        `({value:draft.value,start:draft.selectionStart,end:draft.selectionEnd,scroll:draft.scrollTop,marker:window.sessionMarker})`,
      ),
    };
  });
  for (let index = 0; index < 12; index++) {
    await page.evaluate(() => {
      window.lease.detach();
      window.anchor.remove();
      if (!window.originalGuest.isConnected) throw new Error("Guest disconnected during eviction");
      if (getComputedStyle(window.originalParent).visibility !== "hidden")
        throw new Error("Parked guest is visible");
      window.bind();
    });
  }
  const restored = await page.evaluate(async () => {
    const guest = document.querySelector("webview");
    return {
      sameNode: guest === window.originalGuest,
      sameParent: guest.parentElement === window.originalParent,
      id: guest.getWebContentsId(),
      state: await guest.executeJavaScript(
        `({value:draft.value,start:draft.selectionStart,end:draft.selectionEnd,scroll:draft.scrollTop,marker:window.sessionMarker})`,
      ),
    };
  });
  assert.equal(restored.sameNode, true);
  assert.equal(restored.sameParent, true);
  assert.equal(restored.id, original.id);
  assert.deepEqual(restored.state, original.state);
  assert.equal(requests, 1);
  results.push(
    "PASS: 12 panel evictions preserve guest ID, DOM parent, unsaved text, selection, scroll, and page state; exactly one HTTP load",
  );

  await page.evaluate(() => {
    document.querySelector("#slot").style.display = "none";
  });
  await page.waitForFunction(() => getComputedStyle(window.originalParent).visibility === "hidden");
  await page.evaluate(() => {
    document.querySelector("#slot").style.display = "block";
  });
  await page.waitForFunction(
    () => getComputedStyle(window.originalParent).visibility === "visible",
  );
  assert.equal(
    await page.evaluate(() => document.querySelector("webview").getWebContentsId()),
    original.id,
  );
  assert.equal(requests, 1);
  results.push("PASS: retained panel hide/show does not recreate or reload the guest");

  await page.evaluate(() => {
    window.lease.detach();
    window.anchor.remove();
    window.retention.disposeEditors();
  });
  assert.equal(await page.locator("webview").count(), 0);
  assert.equal(await page.locator("[data-paseo-vscode-session]").count(), 0);
  results.push("PASS: plugin cleanup removes the guest and its permanent surface");
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify({ results, editorRequests: requests }, null, 2),
  );
  for (const result of results) console.log(result);
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
}
