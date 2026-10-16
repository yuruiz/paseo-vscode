// Runs the production session manager with real Electron webviews. Supply an
// Electron binary and a display; all generated files live under PASEO_TEST_ROOT.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.resolve(process.env.PASEO_TEST_ROOT || path.join(root, ".dev/retention"));
const executablePath = process.env.PASEO_ELECTRON_PATH;
assert.ok(executablePath, "Set PASEO_ELECTRON_PATH to your Electron executable");
await mkdir(output, { recursive: true });
await mkdir(path.join(output, "tmp"), { recursive: true });
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import * as retention from './client/web';
      import { SessionsScreen } from './client/sessions';
      window.retention = retention;
      const theme = { colors: { foreground: '#f1f1f1', foregroundMuted: '#aaa', surface0: '#181818', surface1: '#303030', border: '#444' } };
      let manager;
      window.showManager = (compact = false) => {
        manager ??= createRoot(document.querySelector('#manager'));
        manager.render(createElement(SessionsScreen, {
          theme, host: { id: 'fixture-host', label: 'Fixture host' }, layout: { compact, platform: 'web' },
          openEditor: workspaceId => {
            if (window.failOpen) throw new Error('Workspace removed');
            window.openedWorkspace = workspaceId;
          },
        }));
      };
      window.showEditor = url => {
        const editor = createRoot(document.querySelector('#slot'));
        editor.render(createElement(retention.EditorWebview, {
          sessionKey: 'mounted-editor', url, theme, openExternal: () => {},
          info: { hostId: 'fixture-host', workspaceId: 'mounted', name: 'Mounted editor', directory: '/workspace/mounted' },
        }));
      };
    `,
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  plugins: [
    {
      name: "native-primitives",
      setup(builder) {
        builder.onResolve({ filter: /^react-native$/ }, () => ({
          path: "react-native",
          namespace: "fixture",
        }));
        // Only the host's layout primitives are adapted. Components, hooks, state,
        // event handlers, the session registry, and Electron webviews are real.
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          resolveDir: root,
          loader: "js",
          contents: `
          import { createElement as h } from 'react';
          export const Platform = { OS: 'web' };
          export const View = ({children, style}) => h('div', {style: {display:'flex',flexDirection:'column',minWidth:0,...style}}, children);
          export const Text = ({children, style, accessibilityRole}) => h('span', {style, role:accessibilityRole}, children);
          export const Pressable = ({children, style, onPress, accessibilityLabel}) => h('button', {style, onClick:onPress, 'aria-label':accessibilityLabel}, children);
          export const ScrollView = ({children, style, contentContainerStyle}) => h('div', {style:{overflow:'auto',...style}}, h(View, {style:contentContainerStyle}, children));
        `,
        }));
      },
    },
  ],
});
const compiled = bundle.outputFiles[0].text;

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
  await win.loadURL('data:text/html,' + encodeURIComponent('<style>body {margin:0;font-family:system-ui;background:#181818} #slot {position:fixed;left:100px;top:90px;width:800px;height:600px;display:flex;flex-direction:column} #manager {position:relative;z-index:2;background:#181818}</style><input id="host" aria-label="Host composer"><div id="slot"></div><div id="manager"></div>'));
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
      new Function(compiled)();
      window.bind = () => {
        const anchor = document.createElement("div");
        anchor.style.cssText = "width:100%;height:100%";
        document.querySelector("#slot").appendChild(anchor);
        window.anchor = anchor;
        window.lease = window.retention.attachEditor({
          sessionKey: "fixture-workspace",
          info: {
            hostId: "fixture-host",
            workspaceId: "fixture-workspace",
            name: "Fixture workspace",
            directory: "/workspace/fixture",
          },
          url: editorUrl,
          anchor,
          openExternal: () => {},
          onStatus: (status) => {
            window.editorStatus = status;
          },
          onRelease: () => {},
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
    undefined,
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
    window.showManager();
  });
  await page.getByText("1 active · Fixture host · This client", { exact: true }).waitFor();
  await page.getByText(/Background · Last active/).waitFor();
  await page
    .getByRole("button", { name: "Open editor for Fixture workspace", exact: true })
    .click();
  assert.equal(await page.evaluate(() => window.openedWorkspace), "fixture-workspace");
  await page.evaluate(() => {
    window.failOpen = true;
  });
  await page
    .getByRole("button", { name: "Open editor for Fixture workspace", exact: true })
    .click();
  await page.getByText(/Could not open this workspace/).waitFor();
  await page.getByRole("button", { name: "Release Fixture workspace", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.locator("webview").count(), 1);
  await page.screenshot({ path: path.join(output, "sessions-wide.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.showManager(true));
  await page.screenshot({ path: path.join(output, "sessions-compact.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true);
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.getByRole("button", { name: "Release Fixture workspace", exact: true }).click();
  await page.getByRole("button", { name: "Confirm release", exact: true }).click();
  await page.getByText("No active VS Code sessions", { exact: true }).waitFor();
  assert.equal(await page.locator("webview").count(), 0);
  results.push(
    "PASS: manager lists parked sessions, opens the workspace, handles navigation errors, cancels and confirms release, and fits a compact viewport",
  );

  await page.evaluate((editorUrl) => {
    window.showEditor(editorUrl);
  }, editorUrl);
  await page.getByText("1 active · Fixture host · This client", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Release all…", exact: true }).click();
  await page.getByRole("button", { name: "Confirm release", exact: true }).click();
  await page.getByText("No active VS Code sessions", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open VS Code", exact: true }).waitFor();
  assert.equal(await page.locator("webview").count(), 0);
  // Move the manager out of the way to exercise the mounted panel's reopen button.
  await page.evaluate(() => (document.querySelector("#manager").style.display = "none"));
  await page.getByRole("button", { name: "Open VS Code", exact: true }).click();
  await page.waitForFunction(() => window.retention.getEditorSessions().length === 1);
  assert.equal(await page.locator("webview").count(), 1);
  results.push(
    "PASS: bulk release updates a mounted editor to Open VS Code and explicit reopen creates a new session",
  );

  await page.evaluate(() => {
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
