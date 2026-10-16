import { createElement, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

// DOM access is confined to this module and gated on the web platform. The
// plugin SDK deliberately does not include lib.dom in native client bundles.
interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface WebElement {
  style: Record<string, string>;
  isConnected: boolean;
  parentElement: WebElement | null;
  appendChild(child: WebElement): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): Bounds;
}
interface GuestEvent {
  isMainFrame?: boolean;
  errorCode?: number;
  message?: string;
}
interface EditorGuest extends WebElement {
  src: string;
  addEventListener(name: string, listener: (event: GuestEvent) => void): void;
  removeEventListener(name: string, listener: (event: GuestEvent) => void): void;
  reload(): void;
  blur(): void;
  executeJavaScript(script: string): Promise<unknown>;
}
interface WebEnvironment {
  document: { body: WebElement; createElement(tag: string): WebElement };
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(id: number): void;
  getComputedStyle(element: WebElement): {
    visibility: string;
    overflowX: string;
    overflowY: string;
  };
}
function environment(): WebEnvironment | null {
  if (Platform.OS !== "web") return null;
  const web = globalThis as unknown as WebEnvironment;
  return web.document?.body ? web : null;
}

const EXTERNAL_LINK_SIGNAL = "paseo:vscode:external-link";
const TAKE_EXTERNAL_LINKS = `window[Symbol.for("paseo.vscode.externalLinks")]?.splice(0) ?? []`;
// This workspace panel is not a registered Paseo browser. Route detached links
// through client navigation; preserve native WindowProxy/opener contracts for
// callers that need an actual popup.
// Runs only in the editor's page world; it never sends login URLs to the daemon.
export const EDITOR_POPUP_SCRIPT = `(() => {
  const marker = Symbol.for("paseo.vscode.popups");
  const original = window.open;
  if (original[marker]) return;
  const links = [];
  window[Symbol.for("paseo.vscode.externalLinks")] = links;
  function open(url, target, features) {
    if (["_self", "_parent", "_top"].includes(String(target).toLowerCase())) {
      return original.call(window, url, target, features);
    }
    // VS Code's openExternal uses _blank + noopener and does not need a handle.
    // Let the client-owned browser tab handle it, including on older desktops.
    const detached = /(?:^|,)\\s*(?:noopener|noreferrer)(?:\\s*=\\s*(?:yes|1|true))?\\s*(?:,|$)/i.test(String(features ?? ""));
    if (url && (!target || target === "_blank") && detached) {
      const parsed = new URL(String(url), location.href);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        if (links.length < 20) {
          links.push(parsed.href);
          // Signal only: authenticated URLs never appear in console output.
          console.debug("paseo:vscode:external-link");
        }
        return null;
      }
    }
    const popupFeatures = String(features ?? "").split(",")
      .filter(feature => !/^\\s*popup(?:\\s*=|\\s*$)/i.test(feature));
    popupFeatures.push("popup=yes");
    return original.call(window, url, target, popupFeatures.join(","));
  }
  Object.defineProperty(open, marker, { value: true });
  window.open = open;
})()`;

interface EditorStatus {
  failed: boolean;
  popupFailed: boolean;
}
interface Binding {
  anchor: WebElement;
  onStatus(status: EditorStatus): void;
  openExternal(url: string): void;
}
interface ResidentEditor {
  url: string;
  surface: WebElement;
  guest: EditorGuest;
  bindings: Set<Binding>;
  status: EditorStatus;
  disposed: boolean;
  geometry: string | null;
  openExternal(url: string): void;
  disposeEvents(): void;
}

// Each evaluated plugin installation owns this registry. In particular, it is
// not a global cache shared with another daemon or another installed plugin ID.
const editors = new Map<string, ResidentEditor>();
let frame: number | null = null;

function publish(editor: ResidentEditor, patch: Partial<EditorStatus>) {
  if (editor.disposed) return;
  editor.status = { ...editor.status, ...patch };
  for (const binding of editor.bindings) binding.onStatus(editor.status);
}

function park(editor: ResidentEditor) {
  if (editor.disposed || editor.geometry === null) return;
  editor.geometry = null;
  editor.guest.blur();
  editor.surface.style.visibility = "hidden";
  editor.surface.style.pointerEvents = "none";
  editor.surface.setAttribute("aria-hidden", "true");
}

function visibleBounds(
  web: WebEnvironment,
  anchor: WebElement,
): { bounds: Bounds; clip: Bounds } | null {
  if (!anchor.isConnected) return null;
  const bounds = anchor.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  let left = bounds.left,
    top = bounds.top;
  let right = left + bounds.width,
    bottom = top + bounds.height;
  // A panel can be retained but hidden, clipped by a split, or scrolled. Keep
  // the guest below Paseo's overlay plane and inside every clipping ancestor.
  for (let node: WebElement | null = anchor; node; node = node.parentElement) {
    const style = web.getComputedStyle(node);
    if (style.visibility === "hidden" || style.visibility === "collapse") return null;
    const clipX = /^(hidden|clip|scroll|auto)$/.test(style.overflowX);
    const clipY = /^(hidden|clip|scroll|auto)$/.test(style.overflowY);
    if (clipX || clipY) {
      const rect = node.getBoundingClientRect();
      if (clipX) {
        left = Math.max(left, rect.left);
        right = Math.min(right, rect.left + rect.width);
      }
      if (clipY) {
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.top + rect.height);
      }
    }
  }
  if (right <= left || bottom <= top) return null;
  return { bounds, clip: { left, top, width: right - left, height: bottom - top } };
}

function present(web: WebEnvironment, editor: ResidentEditor) {
  let selected: { binding: Binding; bounds: Bounds; clip: Bounds } | null = null;
  for (const binding of editor.bindings) {
    const geometry = visibleBounds(web, binding.anchor);
    if (geometry) selected = { binding, ...geometry };
  }
  if (!selected) {
    park(editor);
    return;
  }
  const { bounds, clip, binding } = selected;
  editor.openExternal = binding.openExternal;
  const geometry = JSON.stringify([
    bounds.left,
    bounds.top,
    bounds.width,
    bounds.height,
    clip.left,
    clip.top,
    clip.width,
    clip.height,
  ]);
  if (geometry === editor.geometry) return;
  editor.geometry = geometry;
  Object.assign(editor.surface.style, {
    left: `${clip.left}px`,
    top: `${clip.top}px`,
    width: `${clip.width}px`,
    height: `${clip.height}px`,
    visibility: "visible",
    pointerEvents: "auto",
  });
  Object.assign(editor.guest.style, {
    left: `${bounds.left - clip.left}px`,
    top: `${bounds.top - clip.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  });
  editor.surface.setAttribute("aria-hidden", "false");
}

function updateSurfaces() {
  frame = null;
  const web = environment();
  if (!web) return;
  let attached = false;
  for (const editor of editors.values()) {
    if (editor.bindings.size === 0) continue;
    attached = true;
    present(web, editor);
  }
  // No timer or layout polling survives the last mounted panel. Cached guests
  // remain connected even after React's three-tab cache evicts their panels.
  if (attached) frame = web.requestAnimationFrame(updateSurfaces);
}

function createEditor(
  web: WebEnvironment,
  url: string,
  openExternal: (url: string) => void,
): ResidentEditor {
  const surface = web.document.createElement("div");
  surface.setAttribute("data-paseo-vscode-session", "");
  surface.setAttribute("aria-hidden", "true");
  Object.assign(surface.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    visibility: "hidden",
    pointerEvents: "none",
    zIndex: "0",
  });
  const guest = web.document.createElement("webview") as EditorGuest;
  guest.setAttribute("partition", "persist:paseo-browser");
  guest.setAttribute("allowpopups", "true");
  guest.setAttribute("spellcheck", "false");
  Object.assign(guest.style, {
    display: "flex",
    position: "absolute",
    left: "0",
    top: "0",
    width: "1280px",
    height: "800px",
    border: "0",
  });
  const editor: ResidentEditor = {
    url,
    surface,
    guest,
    bindings: new Set(),
    status: { failed: false, popupFailed: false },
    disposed: false,
    geometry: null,
    openExternal,
    disposeEvents: () => {},
  };
  const onFailure = (event: GuestEvent) => {
    if (event.isMainFrame && event.errorCode !== -3) publish(editor, { failed: true });
  };
  const onNavigate = () => publish(editor, { failed: false });
  const onGone = () => publish(editor, { failed: true });
  const onReady = async () => {
    try {
      await guest.executeJavaScript(EDITOR_POPUP_SCRIPT);
      publish(editor, { popupFailed: false });
    } catch {
      publish(editor, { popupFailed: true });
    }
  };
  const onConsole = async (event: GuestEvent) => {
    if (event.message !== EXTERNAL_LINK_SIGNAL || editor.disposed) return;
    try {
      const links = await guest.executeJavaScript(TAKE_EXTERNAL_LINKS);
      if (editor.disposed || !Array.isArray(links)) return;
      for (const link of links) {
        if (typeof link === "string" && /^https?:\/\//i.test(link)) editor.openExternal(link);
      }
    } catch {
      publish(editor, { popupFailed: true });
    }
  };
  const listeners = {
    "did-fail-load": onFailure,
    "did-navigate": onNavigate,
    "render-process-gone": onGone,
    "dom-ready": onReady,
    "console-message": onConsole,
  };
  for (const [event, listener] of Object.entries(listeners))
    guest.addEventListener(event, listener);
  editor.disposeEvents = () => {
    for (const [event, listener] of Object.entries(listeners))
      guest.removeEventListener(event, listener);
  };
  // Set the initial URL once. A remount must never navigate again, even after
  // VS Code redirects or changes the current page's URL during login.
  guest.src = url;
  surface.appendChild(guest);
  web.document.body.appendChild(surface);
  return editor;
}

function destroyEditor(editor: ResidentEditor) {
  park(editor);
  editor.disposed = true;
  editor.disposeEvents();
  editor.bindings.clear();
  editor.surface.remove();
}

export function releaseEditor(sessionKey: string): void {
  if (Platform.OS !== "web") return;
  const editor = editors.get(sessionKey);
  if (!editor) return;
  destroyEditor(editor);
  editors.delete(sessionKey);
  stopIdleFrame();
}

function stopIdleFrame() {
  if (frame !== null && ![...editors.values()].some((editor) => editor.bindings.size > 0)) {
    environment()?.cancelAnimationFrame(frame);
    frame = null;
  }
}

/** Installation cleanup, including reload, disable, host disconnect, and removal. */
export function disposeEditors(): void {
  if (Platform.OS !== "web") return;
  for (const editor of editors.values()) destroyEditor(editor);
  editors.clear();
  stopIdleFrame();
}

export function attachEditor(input: {
  sessionKey: string;
  url: string;
  anchor: WebElement;
  openExternal(url: string): void;
  onStatus(status: EditorStatus): void;
}): { detach(): void; reload(): void } | null {
  const web = environment();
  if (!web) return null;
  let editor = editors.get(input.sessionKey);
  if (editor && editor.url !== input.url) {
    destroyEditor(editor);
    editors.delete(input.sessionKey);
    editor = undefined;
  }
  if (!editor) {
    editor = createEditor(web, input.url, input.openExternal);
    editors.set(input.sessionKey, editor);
  }
  const resident = editor;
  const binding: Binding = {
    anchor: input.anchor,
    openExternal: input.openExternal,
    onStatus: input.onStatus,
  };
  resident.bindings.add(binding);
  input.onStatus(resident.status);
  present(web, resident);
  if (frame === null) frame = web.requestAnimationFrame(updateSurfaces);
  return {
    detach() {
      resident.bindings.delete(binding);
      if (!resident.disposed) present(web, resident);
      stopIdleFrame();
    },
    reload() {
      if (resident.disposed) return;
      publish(resident, { failed: false, popupFailed: false });
      resident.guest.reload();
    },
  };
}

/** Only mounted by an Electron host (identified by its openBrowser capability). */
export function EditorWebview({
  sessionKey,
  url,
  theme,
  openExternal,
}: {
  sessionKey: string;
  url: string;
  theme: PluginTheme;
  openExternal: (url: string) => void;
}) {
  const anchor = useRef<WebElement | null>(null);
  const lease = useRef<ReturnType<typeof attachEditor>>(null);
  const [status, setStatus] = useState<EditorStatus>({ failed: false, popupFailed: false });
  const [released, setReleased] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  useLayoutEffect(() => {
    if (released || !anchor.current) return;
    const attached = attachEditor({
      sessionKey,
      url,
      anchor: anchor.current,
      openExternal,
      onStatus: setStatus,
    });
    lease.current = attached;
    return () => {
      attached?.detach();
      lease.current = null;
    };
  }, [sessionKey, url, openExternal, released]);
  const retry = useCallback(() => lease.current?.reload(), []);
  const release = useCallback(() => {
    releaseEditor(sessionKey);
    setConfirmRelease(false);
    setReleased(true);
  }, [sessionKey]);
  if (Platform.OS !== "web") return null;
  const button = (label: string, onPress: () => void) =>
    createElement(
      Pressable,
      { onPress, accessibilityRole: "button", style: { padding: 8 } },
      createElement(Text, { style: { color: theme.colors.foreground } }, label),
    );
  return createElement(
    View,
    { style: { flex: 1 } },
    released
      ? button("Open VS Code", () => setReleased(false))
      : createElement(
          View,
          { style: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end" } },
          confirmRelease
            ? createElement(
                Text,
                { style: { color: theme.colors.foreground, flex: 1, padding: 8 } },
                "Save your edits before releasing this editor session.",
              )
            : null,
          confirmRelease ? button("Cancel", () => setConfirmRelease(false)) : null,
          button(
            confirmRelease ? "Release session" : "Release editor…",
            confirmRelease ? release : () => setConfirmRelease(true),
          ),
        ),
    !released && (status.failed || status.popupFailed)
      ? button(
          status.popupFailed
            ? "Could not enable login windows. Reload VS Code"
            : "Could not load VS Code. Retry",
          retry,
        )
      : null,
    released
      ? null
      : createElement("div", { ref: anchor, style: { flex: 1, minWidth: 0, minHeight: 0 } }),
  );
}
