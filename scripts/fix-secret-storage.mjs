import { constants } from "node:fs";
import { copyFile, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// Redirect the pinned remote extension host's SecretStorage implementation to a
// shared server store, preserving the existing extension API and change events.
export async function fixSecretStorage(binary) {
  const root = path.dirname(path.dirname(await realpath(binary)));
  const product = JSON.parse(await readFile(path.join(root, "product.json"), "utf8"));
  if (
    product.version !== "1.109.5" ||
    product.commit !== "072586267e68ece9a47aa43f8c108e0dcbf44622"
  )
    return false;
  const directory = path.join(root, "out/vs/workbench/api/node");
  const file = path.join(directory, "extensionHostProcess.js");
  const original = await readFile(file, "utf8");
  const before = "this.a=e.getProxy(Q.MainThreadSecretState)";
  const after = "this.a=paseoCreateRemoteSecretStorage(e=>this.b.fire(e))";
  if (original.split(before).length + original.split(after).length !== 3)
    throw new Error("Unexpected OpenVSCode secret storage entrypoint; runtime was not patched.");
  const module = await readFile(new URL("../runtime/secret-storage.js", import.meta.url), "utf8");
  const version = createHash("sha256").update(module).digest("hex").slice(0, 16);
  const moduleName = `paseo-secret-storage.${version}.mjs`;
  const patched =
    `import { createRemoteSecretStorage as paseoCreateRemoteSecretStorage } from "./${moduleName}";\n` +
    original
      .replace(
        /^import \{ createRemoteSecretStorage as paseoCreateRemoteSecretStorage \} from "\.\/paseo-secret-storage\.[a-f0-9]+\.mjs";\n/,
        "",
      )
      .replace(before, after);
  await writeFile(path.join(directory, moduleName), module);
  if (patched === original) return false;
  try {
    await copyFile(file, `${file}.paseo-secrets-original`, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const temporary = `${file}.paseo-secrets-${process.pid}`;
  await writeFile(temporary, patched);
  await rename(temporary, file);
  return true;
}
