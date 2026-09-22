import { constants } from "node:fs";
import { copyFile, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const oldEndpoint =
  "https://{{uuid}}.vscode-cdn.net/insider/ef65ac1ba57f57f2a3961bfe94aa20481caca4c6/out/vs/workbench/contrib/webview/browser/pre/";
const matchingEndpoint =
  "https://{{uuid}}.vscode-cdn.net/stable/072586267e68ece9a47aa43f8c108e0dcbf44622/out/vs/workbench/contrib/webview/browser/pre/";

// OpenVSCode 1.109.5 pins an older webview preload that sends string link events,
// while this workbench expects { uri }. Keep the CDN's isolated webview origins,
// but use assets from the matching upstream VS Code 1.109.5 release.
export async function fixWebviewEndpoint(binary) {
  const root = path.dirname(path.dirname(await realpath(binary)));
  const product = JSON.parse(await readFile(path.join(root, "product.json"), "utf8"));
  if (
    product.version !== "1.109.5" ||
    product.commit !== "072586267e68ece9a47aa43f8c108e0dcbf44622" ||
    ![oldEndpoint, matchingEndpoint].includes(product.webviewContentExternalBaseUrlTemplate)
  ) {
    return false;
  }
  // Product defaults are also inlined in both bundles. Validate all files before
  // writing so an unexpected runtime build is left untouched.
  const changes = [];
  for (const [relative, before, after] of [
    ["product.json", oldEndpoint, matchingEndpoint],
    ["out/server-main.js", oldEndpoint, matchingEndpoint],
    ["out/vs/code/browser/workbench/workbench.js", oldEndpoint, matchingEndpoint],
    // The bundle URL is immutable in browser caches. Existing desktop profiles
    // need a new URL as well as the corrected contents.
    [
      "out/vs/code/browser/workbench/workbench.html",
      '/out/vs/code/browser/workbench/workbench.js"',
      '/out/vs/code/browser/workbench/workbench.js?paseo-webview=1.109.5"',
    ],
  ]) {
    const file = path.join(root, relative);
    const source = await readFile(file, "utf8");
    const oldCount = source.split(before).length - 1;
    const matchingCount = source.split(after).length - 1;
    if (oldCount + matchingCount !== 1) {
      throw new Error(`Unexpected webview configuration in ${file}; runtime was not patched.`);
    }
    if (oldCount) changes.push({ file, source: source.replace(before, after) });
  }
  for (const { file, source } of changes) {
    try {
      await copyFile(file, `${file}.paseo-webview-original`, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const temporary = `${file}.paseo-webview-${process.pid}`;
    await writeFile(temporary, source);
    await rename(temporary, file);
  }
  return changes.length > 0;
}
