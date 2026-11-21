# MC Dev Hub

*Your local projects in one place.* Start, stop and watch your local web projects, call their APIs, see their network traffic and manage their Git, from one page run by a small desktop app.

- **Environments**: one per project folder, as many as you like.
- **Launchers**: each environment can have several, for example `api`, `client` and `admin` in a monorepo. Each launcher has its own command, subfolder, port, URL and environment variables.
- **Master console**: every launcher's output streams live into the page as a tab, with colors. You can also type input to it. No separate console windows open.
- **CLI tabs**: **＋** in the console opens a command line in a launcher's folder, as many as you like per launcher (see below).
- **Split view**: show up to 3 tabs side by side. Drag tabs to rearrange.
- **Network monitor**: a Wireshark-style list of a launcher's API calls, outgoing requests and database connections, labelled **Server** or **Browser** (see below).
- **Running instances**: **Instances ↗** in the top bar lists everything running: MC Dev Hub itself (its server, ports and uptime), your launchers, and dev servers from other sources, each with Start/Stop (stopping MC Dev Hub itself is done from its own window or tray).
- **Terminal / Folder / Editor** buttons open Windows Terminal (or PowerShell), Explorer, or VS Code at the project folder. **⌨** in a console pane opens that tab's folder.
- **Git tab**: branch switcher, ahead/behind, fetch / pull / push, stage, commit (and commit & push), new branch, stash / pop, recent commits, remote origin details with a link to GitHub, plus a box to run any other `git` command.
- **Sites open in app windows**: a launcher's **Open** button (and "open when ready") opens the site in its own app-style window: just the page, titled by the site, with no address bar or browser buttons. Right-click for Back, Forward, Reload, Hard reload, Open in browser, Copy page address, zoom and Inspect; Alt+←/→, F5 and F12 work too. Logins and cookies persist between windows. To use your default browser instead, change **Settings → Open sites in**.
- **API viewer** (Postman-like) for launchers marked **API**: see below.
- **Light and dark** themes (follows the system by default).

```
mc-dev-hub/
  server/                  Node server (no dependencies)
    server.js              HTTP API + live log stream (Server-Sent Events)
    lib/                   processes, git, project detection, OS helpers, config store
    public/                the single-page UI (index.html, app.js, style.css)
  desktop/MCDevHub         Avalonia (C#/.NET 8) desktop app; Windows hosts the UI in WebView2
  data/config.json         your environments + launchers (created on first save, git-ignored)
```

## Requirements

- Node.js 20+ (`node` on PATH; nvm-windows works)
- Git, for the Git tab
- .NET 8 SDK, to build the desktop app
- Microsoft Edge WebView2 Runtime, for the app window (built into Windows 11)

## Build it

`dist/` isn't in the repository, so after cloning (or on a new PC) build the exe once:

```bash
git clone <your repo URL> mc-dev-hub
```
```bash
cd mc-dev-hub
```
```bash
build.cmd
```

Or double-click **`build.cmd`** in the folder. It:

1. checks for the **.NET 8 SDK** (or newer), needed to build, and **Node.js 20+**, needed to run the server;
2. if either is missing, asks whether to install it with `winget`. If you say no (or the install doesn't finish), the build stops and tells you what to install;
3. builds **`dist\MCDevHub.exe`**. The first build downloads packages and takes a minute or two.

Quit MC Dev Hub before rebuilding; a running exe can't be replaced. `build.cmd <folder>` builds into another folder instead. `npm run build:exe` does the same build without the checks.

What a new PC doesn't get from the repository: your environments (`data/` is git-ignored, and its folder paths are per PC; copy `data/config.json` over if you want them), and the desktop settings and site logins in `%APPDATA%\MCDevHub` and `%LOCALAPPDATA%\MCDevHub`.

## Run it

**Desktop app (recommended)**

Double-click **`dist/MCDevHub.exe`**. It's a single self-contained file, so .NET doesn't need to be installed. Pin it to the taskbar or Start menu like any app.

The app starts the server and opens the UI in its own window. Closing the window keeps it in the tray; **Quit** (tray menu or button) stops the server and every running launcher.

On first run it finds `server/` by walking up from its own folder and remembers that path in its settings. After that you can move or copy the exe anywhere. To point it at a different checkout, use **Paths → Server folder**.

After changing the desktop app's code, rebuild the exe (close the running app first):

```bash
build.cmd
```

Changes to `server/` (including the web UI) need no rebuild; just restart the server from the app.

For development you can also run it from source with `npm run desktop`.

**Server only (any browser)**

```bash
npm start
```

Then open http://localhost:4800. Options: `node server/server.js --port 4900 --data D:\launcher-data`.

## Desktop app settings

| Setting | What it does |
|---|---|
| Port | Port of the launcher UI (default 4800). Changing it restarts the server. |
| Open UI in | **App window** (WebView2, native folder picker) or **Default browser** |
| Theme | System / Light / Dark for the desktop window |
| Start the server when this app opens | Otherwise press **Start server** yourself |
| Open the UI once the server is running | Opens the UI right after launch |
| Start with Windows | Adds a `HKCU\...\Run` entry; starts minimized to the tray |
| Closing this window keeps it running in the tray | Otherwise closing quits (and stops everything) |
| Paths | Node.js executable, server folder, data folder |

Desktop settings are saved in `%APPDATA%\MCDevHub\settings.json`; the app windows' browser profile (site logins and cookies) is in `%LOCALAPPDATA%\MCDevHub`. Your environments and launchers are saved in `data/config.json`.

## Using it

1. **+ Environment** → pick the project folder. Drag environments in the sidebar to put them in the order you like. Launchers are detected from `package.json` scripts (`dev`, `start`, …), including npm/yarn/pnpm workspaces and folders like `api/`, `client/`, `apps/*`.
2. Tick the ones you want, or use **+ Launcher** to add your own (any shell command works: `npm run dev`, `dotnet watch`, `python manage.py runserver`, …).
3. **▶ Start** / **■ Stop** / **↻ Restart** per launcher, or **Start all** / **Stop all** (which asks first, listing what it will stop; so do **Stop all** in the Instances window).

A launcher with a **port**:
- gets `PORT=<port>` in its environment (unless you set `PORT` yourself),
- shows **Ready** once that port answers,
- is checked before starting. If something already holds the port (often a leftover dev server), you can stop that process and start, or start anyway.

Options per launcher: open the URL in your browser when ready, and restart automatically if it crashes (up to 5 times in a row).

## AI in the Git tab (Claude Code)

Optional, and off until you turn it on in **Settings → AI in the Git tab**. Each person sets it up on their own PC:

1. **Install Claude Code**: in PowerShell `irm https://claude.ai/install.ps1 | iex`, or `winget install Anthropic.ClaudeCode` (more options in [Anthropic's setup guide](https://code.claude.com/docs/en/setup)). A copy bundled with the Claude desktop app is found too.
2. **Sign in**: run `claude` in a new terminal and follow the browser prompts (needs a Claude Pro, Max, Team or Enterprise plan, or an Anthropic Console account).
3. **Turn it on** in Settings, press **Check again**, and pick the model: **Claude Sonnet 5.5** (default) or **Claude Opus 5.5**.

Then the Git tab has **✨ Commit message**: Claude reads your changes (staged ones if anything is staged, otherwise all) and writes a message into the commit box. Nothing is committed; you edit it and press Commit. An **AI log** under the box shows what it looked at, which style it followed and roughly what it cost.

- **Style:** it follows a rules file in the repo if there is one (`CONTRIBUTING.md`, `CLAUDE.md`, `agent-rules/…`, commitlint config), otherwise the style of the repo's recent commits, otherwise Conventional Commits.
- **Read-only and limited:** Claude Code runs in the environment's folder with only file reading/search and `git status/diff/log/show/branch`. Secret files (`.env`, keys) can't be read and are left out of what's sent. The repo's own Claude settings and hooks aren't used.
- **Your account:** it uses your Claude login and plan; your changes are sent to Anthropic.

## MC Dev Hub's own folder

You can add MC Dev Hub's own folder (or a folder inside it) as an environment, e.g. to use its Git tab and terminal. It's recognised automatically and gets no launchers: adding, detecting and starting them is turned off, since MC Dev Hub is already running and a second copy would fight it for its port and data. The Network tab is hidden there too. CLI tabs (in the project root), Terminal, Folder, Editor and Git work as usual.

## Console tabs, CLI and split view

The console under the launcher list has a tab for each launcher's output.

- **＋** adds a **CLI tab**: a command line in the **project root** (the environment's folder) or in a **launcher's folder**, as many as you like. A launcher's CLI uses that launcher's environment variables (`.env` text and `PORT`); a project-root CLI uses plain ones. E.g. one for `git log` in the root and one for `npm install` in `apps/api` while the dev server runs. With no launchers, **＋** opens a project-root CLI right away.
  - Each command you type runs in the shell chosen in **Settings → Shell for CLI tabs** (PowerShell by default; Command Prompt, PowerShell 7 and Git Bash when installed).
  - `cd` is remembered between commands; `cls` / `clear` / **Ctrl+L** clear the tab; **↑ / ↓** recall earlier commands.
  - While a command runs, what you type goes to it as input, and **Ctrl+C** or **■ Stop** stops it (with its child processes).
  - Variables you `set` don't carry over to the next command, since each command is a fresh shell. Put lasting ones in the launcher's environment variables.
  - Closing a CLI tab stops what's running in it. CLI tabs end when the server stops.
- **Split view**: up to 3 panes side by side.
  - Drag a tab onto the left or right edge of a pane to split it there, or press **◫** to move the current tab into a new pane.
  - Drag a tab onto another pane, or along a tab bar, to move or reorder it. **✕** closes a pane; its tabs move to the pane next to it.
  - The layout is remembered per environment.
- Clicking a launcher in the list shows its output tab; clicking a tab selects its launcher.

## Network monitor

Turn it on per launcher: the switch at the top of the **Network** tab, or **Monitor network traffic** in the launcher's Edit dialog. It's off by default. It takes effect the next time the launcher starts; a running launcher shows **Restart to capture**.

What's captured, and how each entry is labelled:

| Label | Where it comes from | What you see |
|---|---|---|
| **Server · In** | inside the launcher's Node processes | requests your server receives: method, URL, status, timing, headers, bodies |
| **Server · Out** | inside the launcher's Node processes | calls your server makes with `fetch`, axios, `http`/`https` (HTTPS in plain text, since it's read before encryption), and TCP connections to databases, caches and queues (PostgreSQL, MySQL, MongoDB, Redis, RabbitMQ, Kafka, …) |
| **Browser** | the app's own site window (WebView2 DevTools events) | everything the page loads and calls, including calls straight to other services that never touch your server |

- **How server capture works:** a small script (`server/monitor/hook.cjs`) is loaded into the launcher's Node processes with `NODE_OPTIONS=--require`. It only listens to Node's built-in diagnostics channels; your code isn't changed.
- **Launchers that aren't Node** (Python, .NET, Go, …): you get their open TCP connections (checked every 5 s) and, in the app window, the browser side.
- **Browser capture** needs the site to be open in the app's window (**Settings → Open sites in → App window**). Sites in Chrome/Edge aren't seen; use their DevTools.

Filters:
- **All · Server · Browser** chooses the source.
- Type chips: **API calls**, **Outgoing** and **Databases & sockets** are on by default. **Static files**, **Dev server** (hot reload, `/@vite`, `/_next/static`, source maps), **Health checks** and **Other TCP** are hidden until you turn them on.
- **Errors only**, plus a text filter for URL, host, method or status.
- **Duplicates**: when the browser and the server both captured the same request, both rows get a 🔗 that jumps to the other side. **Hide duplicates** shows the pair once, labelled **Browser + Server**. Pairs are matched by method, path and timing, so it's a best guess when identical requests fire at the same moment.

Click a row for headers and bodies (up to 32 kB each; gzip/brotli are decoded), **Copy cURL** and **Copy URL**. `Authorization`, cookies and API-key headers are masked until you tick **Show secrets**. Up to 3,000 entries are kept per environment, in memory only.

## API viewer

Each launcher is a **Website**, an **API**, or **Both** (set in the launcher's Edit dialog). New launchers are typed automatically:
- **Both:** a frontend framework with its own API routes (Next `app/**/route.ts` or `pages/api`, Nuxt `server/api`, SvelteKit `+server.ts`), a frontend plus a server framework (e.g. Vite + Express), or a server that also serves a page (`express.static`, `sendFile`, `public/index.html`).
- **API:** a server framework (Express, Fastify, Hono, Koa, NestJS, …) or plain Node `http` server without a page.
- **Website:** a frontend only.

Launchers that are API or Both get a **⚡ API** button and the environment gets an **API** tab. Both keeps its **Open** button for the site.

Routes are found automatically:

1. If the API is running and serves an **OpenAPI/Swagger** document (`/openapi.json`, `/swagger.json`, `/api-docs`, `/docs-json`, …), that's used.
2. Otherwise the source is read:
   - **Routes and prefixes:** Express / Hono / Fastify / Koa routers, including routers made in factory functions in other files and mounted with prefixes (`app.use('/v1', v1)`, `v1.use('/admin', admin)`). Also read: Next.js route handlers (`app/**/route.ts`, `pages/api/**`, including wrappers like `export const POST = authedRoute(...)`), SvelteKit `+server.ts`, Nuxt `server/api`, and NestJS controllers.
   - **Plain Node `http` servers:** `pathname === '/api/x' && req.method === 'POST'`, `p.match(/^/api/x/([^/]+)$/)` and `'GET /api/x'` dispatch strings.
   - **Import aliases:** `tsconfig`/`jsconfig` `paths` aliases like `@/…` are followed.
   - **Body:** from **zod** schemas used on the request (`schema.parse(req.body)`, `zValidator('json', schema)`, validation middleware), including schemas imported from shared workspace packages. Fields, types, enums and optional/default values become a ready-to-edit JSON example. Nest DTO classes and `req.body.x` / destructuring work too, and multer uploads become a multipart form with a file picker.
   - **Query, headers and params:** from `req.query.x`, `searchParams.get('x')`, `req.get('x')`, and `:id`-style path parameters.
   - **Auth:** middleware such as `requireSession` or `requireAuth` is shown with a 🔒 on each route behind it.

The route list has two tabs:
- **Detected**: the routes found above. Their method and address come from the code, so they're locked; you fill in path parameters, query, headers and body. Routes that accept any method keep a method picker. **＋ Save to Custom** copies the route, as filled in, to your Custom list.
- **Custom**: your own requests for this API, saved with the launcher in `data/config.json`. Everything is editable there (name, method, address, query, headers, raw/JSON or form-data body), with Duplicate and Delete. Addresses on the launcher itself are saved as paths (`/api/x`), so a new port doesn't break them.

New Custom requests come from:
- **＋ New**: a blank request.
- **⧉ Paste cURL**: paste a curl command, e.g. DevTools › Copy as cURL (bash or cmd) or one written for PowerShell. Common options are understood (`-X`, `-H`, `-d`/`--data-raw`/`--json`, `-F`, `-u`, `-b`, `-G`…). If it matches a detected route, that's pointed out.
- **↻ Replay** on a request in the Network tab: opens it with its method, address, headers and body, minus headers the browser adds itself.

**The running app's token.** With the **Network monitor** on, the API tab picks up the bearer token your app is using: the newest `Authorization: Bearer …` sent to this API (requests answered 401/403 don't count), or a token in a captured login response. A bar above the request shows it masked (`eyJhbG…x9Qw`, seen 8s ago in `GET /api/me`) with **Use it**, which puts it in the shared **Auth & headers**. **Keep in sync** follows the app's newest token automatically. Nothing is read from the site or its storage, and with the monitor off there's no auto-fill.

Secret header values (`Authorization`, cookies, API keys) are masked in the API tab, in replayed requests and in **Auth & headers**; 👁 shows them.

**Path parameters in Custom requests:** write `:id` or `{id}` in the address (`/users/:id/posts/{postId}`) and fill the values under **Params › Path**; the address shown under them is what gets sent. **Save to Custom** on a detected route keeps its `:id` placeholders and their values.

**Responses are kept per request:** each route and each Custom request keeps its last response while the window is open, so you can move between them and come back. The list shows the last status (`200`, `404`…) next to each one. Closing or reloading the window clears them. (The Network tab works differently: captures live in the launcher server, so they survive closing the window and are cleared when the server restarts or you press **Clear**.)

These open as **Not saved** until you press **＋ Save to Custom**. `Authorization`, cookie and API-key headers are never saved with a Custom request; they're kept for the current session only, and your shared **Auth & headers** supply them when sending.

Sending requests:
- Requests go through the launcher server, so CORS doesn't get in the way. Cookies a response sets are kept per API, like Postman.
- **🔑 Auth & headers** holds headers sent with every request. After a login request, **Use token** on the response saves `Authorization: Bearer <token>` there.
- Edits to params and bodies are remembered per route. **Ctrl+Enter** sends. **Copy cURL** copies the request.
- **↻ Rescan** re-reads the code after you add routes.

The code reader is a heuristic, not a compiler. If something is missed, you can still type any URL, method and body yourself, or serve an OpenAPI document from your API.

## How it behaves

- **Stopping is complete.** A launcher is stopped with its whole process tree (`taskkill /T`), so `npm run dev` doesn't leave Vite or Next running in the background.
- **When the server stops, every launcher stops.** If the desktop app crashes or is killed, the server notices its pipe to the app closed and shuts down cleanly.
- **Local only.** The server listens on `127.0.0.1` and only answers requests from its own page (Host/Origin checks, JSON-only writes), so other websites can't drive it.
- **Console input is line-based**, in output and CLI tabs alike. You can answer prompts (`y`, Enter, …), but full-screen terminal apps (arrow-key menus, `vim`) need a real terminal. Use **⌨ Terminal**.
- **Git doesn't hang.** Commands run with `GIT_TERMINAL_PROMPT=0`; on Windows, Git Credential Manager shows its own sign-in window when needed. There's intentionally no "discard changes" button; use **Stash** instead, which you can undo.

## macOS (later)

The desktop app is Avalonia, so it already builds on macOS (`net8.0` target). The parts written for macOS (Terminal.app, `open`, the `choose folder` picker, a LaunchAgent for start-at-login) are in place but untested. On macOS the UI opens in the default browser, because the WebView2 window is Windows-only. Adding a native web view there is the remaining step.
