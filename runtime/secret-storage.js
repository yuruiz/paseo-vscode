import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function masterKey(directory, database) {
  const file = path.join(directory, "master.key");
  if (!existsSync(file)) {
    if (existsSync(database) && !existsSync(file))
      throw new Error(
        "Editor credential master key is missing; restore it before opening the store.",
      );
    const temporary = path.join(directory, `.key-${randomUUID()}`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, randomBytes(32));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // Publish a complete key atomically. Concurrent extension hosts all use
      // the winner; no process can observe an empty or half-written key file.
      try {
        linkSync(temporary, file);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const directoryFd = openSync(directory, "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } finally {
      unlinkSync(temporary);
    }
  }
  chmodSync(file, 0o600);
  const key = readFileSync(file);
  if (key.length !== 32) throw new Error("Invalid editor credential master key.");
  return key;
}

// Implements the existing MainThreadSecretState calls for remote Node extension
// hosts. No credentials travel through the browser or the Paseo daemon.
export function createRemoteSecretStorage(
  onChange,
  directory = process.env.PASEO_VSCODE_SECRET_STORAGE ??
    (process.env.VSCODE_AGENT_FOLDER &&
      path.resolve(process.env.VSCODE_AGENT_FOLDER, "../user/secret-storage")),
) {
  if (!directory || !path.isAbsolute(directory))
    throw new Error("An absolute editor credential storage directory is required.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const filename = path.join(directory, "credentials.sqlite");
  const key = masterKey(directory, filename);
  closeSync(openSync(filename, "a", 0o600));
  chmodSync(filename, 0o600);
  const database = new DatabaseSync(filename);
  database.exec(
    "PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS secrets (extension TEXT NOT NULL, name TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY(extension,name))",
  );
  const get = database.prepare("SELECT value FROM secrets WHERE extension=? AND name=?");
  const put = database.prepare(
    "INSERT INTO secrets(extension,name,value) VALUES(?,?,?) ON CONFLICT(extension,name) DO UPDATE SET value=excluded.value",
  );
  const remove = database.prepare("DELETE FROM secrets WHERE extension=? AND name=?");
  const keys = database.prepare("SELECT name FROM secrets WHERE extension=? ORDER BY name");
  const version = database.prepare("PRAGMA data_version");
  const all = database.prepare("SELECT extension,name,hex(value) AS revision FROM secrets");
  const snapshot = () =>
    new Map(all.all().map((row) => [JSON.stringify([row.extension, row.name]), row.revision]));
  let known = snapshot();
  let revision = version.get().data_version;
  function refresh(force = false) {
    const current = version.get().data_version;
    if (!force && revision === current) return;
    revision = current;
    const next = snapshot();
    const changed = new Set([...known.keys(), ...next.keys()]);
    const previous = known;
    known = next;
    for (const id of changed) {
      if (previous.get(id) === next.get(id)) continue;
      const [extensionId, name] = JSON.parse(id);
      onChange({ extensionId, key: name });
    }
  }
  // Forward other clients' updates/deletions to extensions that cache sessions.
  const timer = setInterval(() => {
    try {
      refresh();
    } catch {
      console.error("Could not refresh remote editor credential storage.");
    }
  }, 1000);
  timer.unref();
  return {
    async $getPassword(extension, name) {
      const row = get.get(extension, name);
      if (!row) return undefined;
      const value = Buffer.from(row.value);
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAAD(Buffer.from(JSON.stringify([extension, name])));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
    async $setPassword(extension, name, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(JSON.stringify([extension, name])));
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      put.run(extension, name, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
      refresh(true);
    },
    async $deletePassword(extension, name) {
      remove.run(extension, name);
      refresh(true);
    },
    async $getKeys(extension) {
      return keys.all(extension).map((row) => row.name);
    },
    dispose() {
      clearInterval(timer);
      database.close();
    },
  };
}
