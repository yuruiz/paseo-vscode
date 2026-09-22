import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
import { EDITOR_POPUP_SCRIPT } from "./web";

describe("VS Code login popups", () => {
  it.each([
    [undefined, undefined, undefined],
    ["https://example.test/auth", "auth", "width=780,height=640,popup=0"],
  ])("uses a real Paseo popup for %s and preserves its handle", (url, target, features) => {
    const handle = { closed: false };
    const nativeOpen = vi.fn(() => handle);
    const window = { open: nativeOpen };
    runInNewContext(EDITOR_POPUP_SCRIPT, { window });
    const patched = window.open;
    runInNewContext(EDITOR_POPUP_SCRIPT, { window });
    expect(window.open).toBe(patched);
    expect(Reflect.apply(window.open, window, [url, target, features])).toBe(handle);
    const args = nativeOpen.mock.calls[0] as unknown as [
      string | undefined,
      string | undefined,
      string,
    ];
    expect(args[0]).toBe(url);
    expect(args[1]).toBe(target);
    if (features?.includes("noopener")) expect(args[2]).toContain("noopener");
    expect(args[2]).toContain("popup=yes");
  });

  it.each(["noopener", "noreferrer", "noopener=yes"])(
    "delivers %s login links to the client without a native popup",
    (features) => {
      const nativeOpen = vi.fn();
      const debug = vi.fn();
      const window = { open: nativeOpen };
      runInNewContext(EDITOR_POPUP_SCRIPT, {
        window,
        URL,
        location: { href: "https://editor.test/" },
        console: { debug },
      });
      const login =
        "https://gitkraken.dev/login?state=test-state&redirect_uri=https%3A%2F%2Feditor.test%2Fcallback";
      expect(window.open(login, "_blank", features)).toBeNull();
      expect(nativeOpen).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledExactlyOnceWith("paseo:vscode:external-link");
      expect(
        runInNewContext('window[Symbol.for("paseo.vscode.externalLinks")].splice(0)', { window }),
      ).toEqual([login]);
      expect(
        runInNewContext('window[Symbol.for("paseo.vscode.externalLinks")].splice(0)', { window }),
      ).toEqual([]);
    },
  );

  it("preserves same-window navigation", () => {
    const nativeOpen = vi.fn();
    const window = { open: nativeOpen };
    runInNewContext(EDITOR_POPUP_SCRIPT, { window });
    window.open("https://example.test", "_self", "noopener");
    expect(nativeOpen).toHaveBeenCalledWith("https://example.test", "_self", "noopener");
  });
});
