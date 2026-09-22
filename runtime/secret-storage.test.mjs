import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRemoteSecretStorage } from "./secret-storage.js";

const roots = [],
  stores = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-secrets-"));
  roots.push(root);
  return root;
}
function connect(root, listener = () => {}) {
  const store = createRemoteSecretStorage(listener, root);
  stores.push(store);
  return store;
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("persists encrypted, extension-scoped credentials after reopening", async () => {
  const root = await fixture(),
    first = connect(root);
  await first.$setPassword("gitlens", "account", "synthetic-token");
  const reopened = connect(root);
  expect(await reopened.$getPassword("gitlens", "account")).toBe("synthetic-token");
  expect(await reopened.$getPassword("another-extension", "account")).toBeUndefined();
  expect(await reopened.$getKeys("gitlens")).toEqual(["account"]);
  expect(
    (await readFile(path.join(root, "credentials.sqlite"))).includes(
      Buffer.from("synthetic-token"),
    ),
  ).toBe(false);
  expect((await stat(root)).mode & 0o777).toBe(0o700);
  for (const file of ["credentials.sqlite", "master.key"])
    expect((await stat(path.join(root, file))).mode & 0o777).toBe(0o600);
  await reopened.$deletePassword("gitlens", "account");
  expect(await connect(root).$getPassword("gitlens", "account")).toBeUndefined();
});

it("notifies other connected clients when credentials change or are deleted", async () => {
  const root = await fixture(),
    listener = vi.fn();
  const first = connect(root, listener),
    second = connect(root);
  await second.$setPassword("gitlens", "account", "synthetic-token");
  await vi.waitFor(
    () => expect(listener).toHaveBeenCalledWith({ extensionId: "gitlens", key: "account" }),
    { timeout: 2500 },
  );
  expect(await first.$getPassword("gitlens", "account")).toBe("synthetic-token");
  listener.mockClear();
  await second.$deletePassword("gitlens", "account");
  await vi.waitFor(
    () => expect(listener).toHaveBeenCalledWith({ extensionId: "gitlens", key: "account" }),
    { timeout: 2500 },
  );
  expect(await first.$getPassword("gitlens", "account")).toBeUndefined();
});

it("shares a single durable key and preserves concurrent writes from separate extension hosts", async () => {
  const root = await fixture();
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      promisify(execFile)(process.execPath, [
        "--input-type=module",
        "-e",
        `import {createRemoteSecretStorage} from ${JSON.stringify(new URL("./secret-storage.js", import.meta.url).href)};const store=createRemoteSecretStorage(()=>{},${JSON.stringify(root)});await store.$setPassword('extension-${i}','account','value-${i}');store.dispose();`,
      ]),
    ),
  );
  const store = connect(root);
  for (let i = 0; i < 6; i++)
    expect(await store.$getPassword(`extension-${i}`, "account")).toBe(`value-${i}`);
});

it("fails closed if the master key is lost instead of replacing it and destroying access", async () => {
  const root = await fixture();
  await connect(root).$setPassword("gitlens", "account", "synthetic-token");
  await unlink(path.join(root, "master.key"));
  expect(() => createRemoteSecretStorage(() => {}, root)).toThrow("master key is missing");
});
