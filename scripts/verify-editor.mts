import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";
import { workspaceEditorUrl } from "../server/editor";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    output: { type: "string" },
    chromium: { type: "string" },
    proxy: { type: "string" },
  },
});
if (!values.data || !values.output || !path.isAbsolute(values.output))
  throw new Error("Pass --data and --output absolute paths");
const output = values.output;
const folder = path.join(output, `workspace-${Date.now()}`);
await mkdir(folder, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, stdio: "pipe" });
git("init", "-b", "main");
git("config", "user.name", "Test");
git("config", "user.email", "test@example.test");
await writeFile(path.join(folder, "hello.ts"), "export const value = 1;\n");
git("add", ".");
git("commit", "-m", "base");
const { editorUrl } = JSON.parse(await readFile(path.join(values.data, "connection.json"), "utf8"));
const url = workspaceEditorUrl(editorUrl, folder);
assert.equal(new URL(url).searchParams.has("workspace"), false);
const browser = await chromium.launch({
  executablePath: values.chromium,
  headless: true,
  ...(values.proxy ? { proxy: { server: values.proxy } } : {}),
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
async function command(name: string) {
  await page.keyboard.press("F1");
  await page.locator(".quick-input-widget input").fill(`>${name}`);
  await page
    .locator(".quick-input-list .monaco-list-row")
    .filter({ hasText: name })
    .first()
    .click();
}
async function waitForFile(name: string, expected: string) {
  const deadline = Date.now() + 10000;
  while (true) {
    const content = await readFile(path.join(folder, name), "utf8").catch(() => "");
    if (content === expected) return;
    if (Date.now() > deadline)
      throw new Error(`Workspace file ${name} did not receive the expected content`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Yes, I trust the authors" }).click({ timeout: 30000 });
  await page.locator(".part.sidebar").waitFor({ state: "visible" });
  await page.keyboard.press("Control+p");
  await page.locator(".quick-input-widget input").fill("hello.ts");
  await page
    .locator(".quick-input-list .monaco-list-row")
    .filter({ hasText: "hello.ts" })
    .first()
    .click();
  await page
    .locator(".monaco-editor .view-lines")
    .getByText("value", { exact: false })
    .first()
    .waitFor();
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("export const value = 42;\n");
  await page.keyboard.press("Control+s");
  await waitForFile("hello.ts", "export const value = 42;\n");
  await command("Source Control: Focus on Changes View");
  await page.locator(".scm-view").getByText("hello.ts", { exact: true }).first().waitFor();
  await command("Search: Focus on Search View");
  await page.locator(".search-view .search-widget textarea").first().fill("value");
  await page.locator(".search-view .search-widget textarea").first().press("Enter");
  await page.locator(".search-view").getByText("hello.ts", { exact: true }).first().waitFor();
  await command("Terminal: Create New Terminal");
  await page.locator(".terminal .xterm-helper-textarea").first().focus();
  await page.keyboard.insertText("printf PASEO_TERMINAL_OK > .terminal-proof");
  await page.keyboard.press("Enter");
  await waitForFile(".terminal-proof", "PASEO_TERMINAL_OK");
  await page.screenshot({ path: path.join(output, "full-editor.png") });
  console.log("PASS: full workspace editor, edit/save, Git changes, search, and remote terminal");
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png") });
  await writeFile(path.join(output, "failure.txt"), await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
