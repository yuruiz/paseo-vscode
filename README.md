# Paseo VS Code

Open the current Paseo workspace in a full OpenVSCode Server editor inside a desktop tab.
Files, editing, Git, search, terminals, and supported extensions use the actual workspace on
your remote machine. File changes are saved directly to that workspace.

**You must install and run OpenVSCode Server separately on the Paseo daemon host.** Installing
this plugin adds the Paseo integration; it does not download, start, or host the editor.

## How it works

| Component                    | Runs on                       | Responsibility                                                                                |
| ---------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| Paseo desktop client         | Your local computer           | Displays the editor in **+ → VS Code** and opens extension login pages.                       |
| Paseo daemon and this plugin | Your workspace host           | Resolves the selected workspace path and constructs its editor URL.                           |
| OpenVSCode Server            | The same workspace host       | Serves the editor and runs file operations, terminals, Git, and remote extensions.            |
| HTTPS reverse proxy          | In front of OpenVSCode Server | Provides an editor address reachable from your local computer. Tailscale Serve is one option. |

The desktop connects directly to the editor over HTTPS and WebSocket. This connection is
separate from its connection to the Paseo daemon: Paseo's TCP connection or relay does not
forward editor traffic. Being able to connect to Paseo alone is not enough.

The editor opens the workspace's absolute path from the daemon. Run both services as the same
OS user with access to the same files. An editor on another machine without those paths cannot
open the workspace. With containers, the same absolute paths must exist inside the editor container.

## Prerequisites

- **Local computer:** a Paseo Electron desktop client with plugin workspace tabs and
  `navigation.openBrowser` (present in 0.9.0-beta.1). Other clients can copy the editor link.
  You do not need to install desktop VS Code locally.
- **Workspace host:** a running Paseo daemon with plugins enabled, and a Paseo CLI/daemon pair
  that supports Git plugin sources. If `pluginsEnabled` is disabled, set it to `true` in that
  daemon's `config.json` and run `paseo reload`; no daemon restart is needed.
- **Editor runtime:** [OpenVSCode Server 1.109.5](https://github.com/gitpod-io/openvscode-server/releases/tag/openvscode-server-v1.109.5)
  on a compatible Linux host. Select its x64, arm64, or armhf archive for your CPU. The helper
  scripts' compatibility fixes target this exact release. Microsoft's Remote-SSH server and
  code-server are not substitutes covered by this setup.
- **Host tools and storage:** Node.js 22.13 or later for the launcher, Git for cloning, and
  `curl` and `tar` for the example below. Use a writable runtime directory and persistent editor
  data directory outside the plugin checkout. Install the project's compilers and other tools
  on this host if you need them in the editor terminal.
- **Network:** an HTTPS editor URL with a certificate trusted by the desktop client, including
  WebSocket forwarding. Both the client and server need access to the services used by your
  extensions; the client also loads external webview assets and login pages. The setup below
  uses Tailscale on the host and a client route into the same tailnet, with Serve/HTTPS enabled
  and tailnet access rules allowing the chosen port. An existing HTTPS reverse proxy also works.

## Setup

Run steps 1–4 **on the workspace host where the Paseo daemon runs**, as the user that owns the
workspace. For multiple Paseo hosts, repeat the setup on each host and configure each host's
plugin settings separately. If you switch terminals, set `EDITOR_ROOT` to the same absolute path
before running commands that use it.

### 1. Install OpenVSCode Server and the helper scripts

Choose a writable absolute directory for `EDITOR_ROOT`. This Linux x64 example downloads the
editor and clones this plugin for its launcher. For ARM, change `EDITOR_ARCH` to `arm64` or `armhf`.

```sh
EDITOR_ROOT=/absolute/path/to/paseo-editor
EDITOR_ARCH=x64
mkdir -p "$EDITOR_ROOT/runtime"
curl -fL "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v1.109.5/openvscode-server-v1.109.5-linux-${EDITOR_ARCH}.tar.gz" \
  -o "$EDITOR_ROOT/openvscode-server.tar.gz"
tar -xzf "$EDITOR_ROOT/openvscode-server.tar.gz" \
  -C "$EDITOR_ROOT/runtime" --strip-components=1
git clone https://github.com/yuruiz/paseo-vscode.git "$EDITOR_ROOT/plugin"
```

No `npm ci`, build, or typecheck is required to use the plugin or launcher. Those commands are
for plugin development. The editor runtime, helper checkout, and editor data are separate so
plugin updates do not replace installed extensions or login data.

### 2. Start the editor

Replace the example hostname with the workspace host's Tailscale DNS name, or your reverse
proxy's hostname. Keep the hostname if your client uses domain-based proxy routing.

```sh
node "$EDITOR_ROOT/plugin/scripts/start.mjs" \
  --binary "$EDITOR_ROOT/runtime/bin/openvscode-server" \
  --data "$EDITOR_ROOT/data" \
  --public-url https://YOUR-HOST.YOUR-TAILNET.ts.net:8443
```

The launcher listens on **HTTP at `127.0.0.1:19888` on the workspace host**. `--public-url` only
specifies the address clients will use; it does not configure TLS, create a proxy, or expose a
port. Do not use `https://HOST:19888` against this HTTP listener.

The command runs in the foreground. Keep it running while completing the remaining steps in
another terminal. For ongoing use, run this same launcher under your host's service manager
with absolute paths and the same OS user. The plugin does not start or restart it for you.
Reuse the same `--data` directory across restarts and workspaces to retain extensions and logins.

The launcher generates a connection token and writes the authenticated `editorUrl` to
`<EDITOR_ROOT>/data/connection.json`. It also applies version-specific webview and credential
storage fixes to the runtime. The runtime must be writable; original files are retained with
`.paseo-webview-original` and `.paseo-secrets-original` suffixes.

### 3. Provide an HTTPS endpoint

In another terminal on the workspace host, forward Tailscale HTTPS to the local editor:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:19888
```

Serve may require administrator privileges. For a custom daemon socket, use
`tailscale --socket=/path/to/tailscaled.sock serve ...`. The address Serve reports must match
`--public-url`. Serve runs in the background, but the editor from step 2 must remain running too.

If using another reverse proxy, give it a trusted HTTPS certificate and forward HTTP and
WebSocket traffic to `127.0.0.1:19888`, preserving paths and query parameters. Tailscale is not
required in that case. Do not use the host's loopback address as the remote client's editor URL.

### 4. Install the Paseo plugin

Target the Paseo daemon that owns your workspaces:

```sh
paseo plugin install yuruiz/paseo-vscode
```

If your CLI does not support Git sources, install the helper checkout as a directory source:

```sh
paseo plugin install "$EDITOR_ROOT/plugin"
```

These are alternative installation methods; use one. Directory installation still requires a
compatible plugin-enabled daemon and desktop client. The plugin's runtime ID is `vscode-diff`;
its display name is **VS Code**.

### 5. Configure the address and open a workspace

On your local Paseo desktop client, select the corresponding host and open **Settings → Plugins
→ VS Code → Editor URL**. Copy the complete `editorUrl` value from the host's
`<EDITOR_ROOT>/data/connection.json`, including `?tkn=...`, and select **Save**. This is a
host-specific setting; no server address is hardcoded in the plugin. Do not copy the JSON braces
or add a workspace path yourself.

Select **+ → VS Code** in a workspace's tab bar, or **Open VS Code** in the Command Center.
The plugin appends that workspace's folder path. Use VS Code's file tree, Git views, terminal,
and Extensions view as usual; install GitLens or other desired extensions there separately.
Keep the tab open to switch files without opening another editor connection.

If it does not load, try the authenticated editor URL in a browser on the **local computer**.
Check that the editor is running, HTTPS and WebSocket forwarding work, and that the computer's
network or system proxy can reach the hostname. Treat the connection URL as a credential;
launcher logs may contain authenticated URLs too.

## Extensions and login persistence

OpenVSCode Server provides the VS Code web workbench. Extensions requiring Microsoft's desktop
product or proprietary services may be unavailable. The plugin does not bundle GitLens or other
VS Code extensions.

The editor uses an Electron webview with Paseo's persistent browser profile and system proxy.
Extension `openExternal` login links open in a browser tab on the **Paseo client**. If VS Code asks
to open an external website, select **Open**. The headless host does not need a desktop browser.

Remote extensions share installed extensions and login credentials across workspaces and clients
using the same editor data directory. Credentials are stored in `<data>/user/secret-storage/`
using AES-256-GCM and a separate `master.key`. The directory is owner-only and the key and database
are readable only by that OS user. Back up the whole directory together. Clients with access to
this editor profile share its accounts, including logout. Browser-only extensions retain their
own VS Code Web storage behavior.

After applying runtime fixes to a running editor, use **Developer: Restart Extension Host** in
existing editor windows. New extension hosts use the persistent store automatically.

## Development

Use Node.js 22.13 or later. Install development dependencies with `npm ci`, then run:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
```

Keep all editor data outside this repository. Do not publish `connection.json`, connection tokens,
credential databases or their master keys, local configuration, logs, or browser profiles.
OpenVSCode binaries and user state are distributed separately.

## License

Apache-2.0. Paseo, OpenVSCode Server, and installed VS Code extensions are separate projects with
their own licenses.
