import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

interface EditorGuest {
  src: string;
  addEventListener(name: string, listener: (event: GuestEvent) => void): void;
  removeEventListener(name: string, listener: (event: GuestEvent) => void): void;
  reload(): void;
  executeJavaScript(script: string): Promise<unknown>;
}

interface GuestEvent {
  isMainFrame?: boolean;
  errorCode?: number;
  message?: string;
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

/** Only mounted by an Electron host (identified by its openBrowser capability). */
export function EditorWebview({
  url,
  theme,
  openExternal,
}: {
  url: string;
  theme: PluginTheme;
  openExternal: (url: string) => void;
}) {
  const guest = useRef<EditorGuest | null>(null);
  const [failed, setFailed] = useState(false);
  const [popupFailed, setPopupFailed] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const element = guest.current;
    if (!element) return;
    const onFailure = (event: { isMainFrame?: boolean; errorCode?: number }) => {
      if (event.isMainFrame && event.errorCode !== -3) setFailed(true);
    };
    const onNavigate = () => setFailed(false);
    let active = true;
    const onConsole = async (event: GuestEvent) => {
      if (event.message !== EXTERNAL_LINK_SIGNAL) return;
      try {
        const links = await element.executeJavaScript(TAKE_EXTERNAL_LINKS);
        if (!active || !Array.isArray(links)) return;
        for (const pendingLink of links) {
          if (typeof pendingLink !== "string" || !/^https?:\/\//i.test(pendingLink)) continue;
          openExternal(pendingLink);
        }
      } catch {
        if (active) setPopupFailed(true);
      }
    };
    const onReady = async () => {
      try {
        await element.executeJavaScript(EDITOR_POPUP_SCRIPT);
        if (active) {
          setPopupFailed(false);
        }
      } catch {
        if (active) setPopupFailed(true);
      }
    };
    element.addEventListener("did-fail-load", onFailure);
    element.addEventListener("did-navigate", onNavigate);
    element.addEventListener("dom-ready", onReady);
    element.addEventListener("console-message", onConsole);
    // Bind before navigating: a cached page can reach dom-ready before a React effect.
    if (element.src !== url) element.src = url;
    else void onReady();
    return () => {
      active = false;
      element.removeEventListener("did-fail-load", onFailure);
      element.removeEventListener("did-navigate", onNavigate);
      element.removeEventListener("dom-ready", onReady);
      element.removeEventListener("console-message", onConsole);
    };
  }, [url, openExternal]);
  const retry = useCallback(() => {
    setFailed(false);
    setPopupFailed(false);
    guest.current?.reload();
  }, []);
  if (Platform.OS !== "web") return null;
  return createElement(
    View,
    { style: { flex: 1 } },
    failed || popupFailed
      ? createElement(
          Pressable,
          { onPress: retry, accessibilityRole: "button", style: { padding: 12 } },
          createElement(
            Text,
            { style: { color: theme.colors.foreground } },
            popupFailed
              ? "Could not enable login windows. Reload VS Code"
              : "Could not load VS Code. Retry",
          ),
        )
      : null,
    createElement("webview", {
      ref: guest,
      // Share Paseo's browser profile, including its system proxy and authentication cookies.
      partition: "persist:paseo-browser",
      allowpopups: "true",
      spellcheck: "false",
      style: { display: "flex", flex: 1, width: "100%", height: "100%" },
    }),
  );
}
