import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
import { Platform } from "react-native";
import {
  attachEditor,
  disposeEditors,
  releaseEditor,
  getEditorSessions,
  subscribeEditorSessions,
} from "./web";

class Element {
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  parentElement: Element | null = null;
  children: Element[] = [];
  bounds = { left: 100, top: 70, width: 800, height: 600 };
  computed = { visibility: "visible", overflowX: "visible", overflowY: "visible" };
  listeners = new Map<string, Set<(event: object) => unknown>>();
  navigation: string[] = [];
  currentUrl = "";
  root = false;
  reload = vi.fn();
  blur = vi.fn();
  executeJavaScript = vi.fn(async (_script: string): Promise<unknown> => undefined);
  constructor(readonly tag: string) {}
  get isConnected(): boolean {
    return this.root || Boolean(this.parentElement?.isConnected);
  }
  get src() {
    return this.currentUrl;
  }
  set src(url: string) {
    this.currentUrl = url;
    this.navigation.push(url);
  }
  appendChild(child: Element) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getBoundingClientRect() {
    return this.bounds;
  }
  addEventListener(name: string, listener: (event: object) => unknown) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: (event: object) => unknown) {
    this.listeners.get(name)?.delete(listener);
  }
  async emit(name: string, event = {}) {
    await Promise.all([...(this.listeners.get(name) ?? [])].map((listener) => listener(event)));
  }
}

let body: Element;
let frames: Map<number, () => void>;
let frameId: number;
function anchor() {
  const element = new Element("div");
  body.appendChild(element);
  return element;
}
function guest() {
  return body.children.find((node) => node.attributes["data-paseo-vscode-session"] === "")!
    .children[0];
}
function tick() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback();
}
function attach(sessionKey = '["host-a","workspace-a"]', url = "https://editor.test/?folder=a") {
  const [hostId, workspaceId] = JSON.parse(sessionKey) as string[];
  const options = {
    sessionKey,
    info: { hostId, workspaceId, name: workspaceId, directory: `/workspaces/${workspaceId}` },
    url,
    anchor: anchor(),
    openExternal: vi.fn(),
    onStatus: vi.fn(),
    onRelease: vi.fn(),
  };
  return { ...options, lease: attachEditor(options)! };
}

beforeEach(() => {
  Platform.OS = "web";
  body = new Element("body");
  body.root = true;
  frames = new Map();
  frameId = 0;
  vi.stubGlobal("document", { body, createElement: (tag: string) => new Element(tag) });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("getComputedStyle", (element: Element) => element.computed);
});
afterEach(() => {
  Platform.OS = "web";
  disposeEditors();
  vi.unstubAllGlobals();
});

describe("resident editor lifecycle", () => {
  it("keeps the same connected guest and parent through eviction and remount, without navigating after a redirect", () => {
    const first = attach();
    const webview = guest();
    const parent = webview.parentElement;
    webview.src = "https://editor.test/workbench";
    first.lease.detach();
    first.anchor.remove();
    expect(webview.isConnected).toBe(true);
    expect(parent!.style.visibility).toBe("hidden");
    expect(frames.size).toBe(0);
    const second = attach();
    expect(guest()).toBe(webview);
    expect(webview.parentElement).toBe(parent);
    expect(parent!.style.visibility).toBe("visible");
    expect(webview.navigation).toEqual([first.url, "https://editor.test/workbench"]);
    expect(webview.reload).not.toHaveBeenCalled();
    second.lease.detach();
  });

  it("parks a retained but hidden panel and restores it without replacing the guest", () => {
    const panel = attach();
    const webview = guest();
    panel.anchor.bounds.width = 0;
    tick();
    expect(webview.parentElement!.style.visibility).toBe("hidden");
    expect(webview.parentElement!.style.pointerEvents).toBe("none");
    panel.anchor.bounds = { left: 20, top: 40, width: 900, height: 700 };
    tick();
    expect(webview.parentElement!.style.left).toBe("20px");
    expect(webview.style.width).toBe("900px");
    expect(webview.navigation).toEqual([panel.url]);
  });

  it("clips the resident surface to its panel ancestors", () => {
    const panel = attach();
    const webview = guest();
    const clip = anchor();
    clip.computed.overflowX = "hidden";
    clip.computed.overflowY = "hidden";
    clip.bounds = { left: 150, top: 90, width: 300, height: 200 };
    clip.appendChild(panel.anchor);
    tick();
    expect(webview.parentElement!.style).toMatchObject({
      left: "150px",
      top: "90px",
      width: "300px",
      height: "200px",
    });
    expect(webview.style).toMatchObject({
      left: "-50px",
      top: "-20px",
      width: "800px",
      height: "600px",
    });
    clip.computed.visibility = "hidden";
    tick();
    expect(webview.parentElement!.style.visibility).toBe("hidden");
  });

  it("keeps a second visible attachment when an older attachment unmounts", () => {
    const first = attach();
    const second = attach();
    const webview = guest();
    first.lease.detach();
    expect(webview.parentElement!.style.visibility).toBe("visible");
    expect(frames.size).toBe(1);
    second.lease.detach();
    expect(webview.parentElement!.style.visibility).toBe("hidden");
    expect(frames.size).toBe(0);
  });

  it("separates host and workspace sessions", () => {
    attach();
    attach('["host-b","workspace-a"]');
    attach('["host-a","workspace-b"]');
    expect(
      body.children.filter((node) => node.tag === "div" && node.children[0]?.tag === "webview"),
    ).toHaveLength(3);
  });

  it("replaces the guest only when its configured URL changes", () => {
    const first = attach();
    const oldGuest = guest();
    first.lease.detach();
    attach(first.sessionKey, "https://new-editor.test/");
    expect(oldGuest.isConnected).toBe(false);
    expect(guest()).not.toBe(oldGuest);
    expect(guest().navigation).toEqual(["https://new-editor.test/"]);
    // Cleanup from an old React effect cannot remove the replacement.
    first.lease.detach();
    expect(guest().isConnected).toBe(true);
  });

  it("explicitly releases the guest, listeners, and polling and creates a fresh session on reopen", () => {
    const first = attach();
    const oldGuest = guest();
    releaseEditor(first.sessionKey);
    expect(first.onRelease).toHaveBeenCalledExactlyOnceWith();
    expect(getEditorSessions()).toEqual([]);
    expect(oldGuest.isConnected).toBe(false);
    expect([...oldGuest.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(frames.size).toBe(0);
    first.lease.detach();
    attach();
    expect(guest()).not.toBe(oldGuest);
  });

  it("disposes both mounted and parked sessions on plugin cleanup", () => {
    const first = attach();
    const firstGuest = guest();
    first.lease.detach();
    const second = attach('["host-b","workspace-b"]');
    disposeEditors();
    disposeEditors();
    second.lease.detach();
    expect(firstGuest.isConnected).toBe(false);
    expect(
      body.children.filter((node) => node.attributes["data-paseo-vscode-session"] === ""),
    ).toHaveLength(0);
    expect(frames.size).toBe(0);
  });

  it("retains load errors while parked and retries on the existing guest", async () => {
    const first = attach();
    const webview = guest();
    first.lease.detach();
    await webview.emit("did-fail-load", { isMainFrame: true, errorCode: -105 });
    const second = attach();
    expect(second.onStatus).toHaveBeenLastCalledWith({ failed: true, popupFailed: false });
    second.lease.reload();
    expect(webview.reload).toHaveBeenCalledExactlyOnceWith();
    expect(second.onStatus).toHaveBeenLastCalledWith({ failed: false, popupFailed: false });
    await webview.emit("render-process-gone");
    expect(second.onStatus).toHaveBeenLastCalledWith({ failed: true, popupFailed: false });
  });

  it("ignores aborted or subframe loads", async () => {
    const panel = attach();
    const webview = guest();
    await webview.emit("did-fail-load", { isMainFrame: false, errorCode: -105 });
    await webview.emit("did-fail-load", { isMainFrame: true, errorCode: -3 });
    expect(panel.onStatus).toHaveBeenCalledTimes(1);
  });

  it("does not deliver pending login links after plugin disposal", async () => {
    const panel = attach();
    const webview = guest();
    let finish!: (value: unknown) => void;
    webview.executeJavaScript.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = webview.emit("console-message", { message: "paseo:vscode:external-link" });
    disposeEditors();
    finish(["https://login.test/"]);
    await pending;
    expect(panel.openExternal).not.toHaveBeenCalled();
  });

  it("never touches the document on native platforms", () => {
    Platform.OS = "ios";
    vi.stubGlobal("document", undefined);
    expect(
      attachEditor({
        sessionKey: "native",
        info: { hostId: "host-a", workspaceId: "native", name: "Native", directory: "" },
        url: "https://editor.test/",
        anchor: new Element("div"),
        openExternal: vi.fn(),
        onStatus: vi.fn(),
        onRelease: vi.fn(),
      }),
    ).toBeNull();
    releaseEditor("native");
    disposeEditors();
    expect(frames.size).toBe(0);
  });
});

describe("session manager snapshots", () => {
  it("lists retained sessions without credentials and only notifies on meaningful changes", async () => {
    const changed = vi.fn();
    const unsubscribe = subscribeEditorSessions(changed);
    const first = attach(undefined, "https://editor.test/?tkn=secret");
    const active = getEditorSessions();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ ...first.info, visible: true, failed: false });
    expect(JSON.stringify(active)).not.toContain("secret");
    changed.mockClear();
    first.anchor.bounds.left += 20;
    tick();
    expect(getEditorSessions()).toBe(active);
    expect(changed).not.toHaveBeenCalled();
    first.lease.detach();
    expect(getEditorSessions()[0].visible).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    await guest().emit("render-process-gone");
    expect(getEditorSessions()[0].failed).toBe(true);
    unsubscribe();
    changed.mockClear();
    releaseEditor(first.sessionKey);
    expect(changed).not.toHaveBeenCalled();
  });

  it("updates workspace metadata without replacing the guest", () => {
    const first = attach();
    const before = getEditorSessions()[0];
    const webview = guest();
    first.lease.detach();
    attachEditor({
      ...first,
      anchor: anchor(),
      info: { ...first.info, name: "Renamed", directory: "/renamed" },
    });
    expect(getEditorSessions()[0]).toMatchObject({
      instanceId: before.instanceId,
      name: "Renamed",
      directory: "/renamed",
    });
    expect(guest()).toBe(webview);
  });

  it("does not release newly opened or replacement sessions with an older bulk confirmation", () => {
    const first = attach();
    attach('["host-a","workspace-b"]');
    const confirmed = getEditorSessions();
    first.lease.detach();
    attach(first.sessionKey, "https://new-editor.test/");
    attach('["host-a","workspace-c"]');
    const released = confirmed.map((session) =>
      releaseEditor(session.sessionKey, session.instanceId),
    );
    expect(released).toEqual([false, true]);
    expect(getEditorSessions().map((session) => session.workspaceId)).toEqual([
      "workspace-a",
      "workspace-c",
    ]);
    expect(guest().isConnected).toBe(true);
  });
});
