# AlifGunadi Office

Live pixel-art office for Claude Code, Antigravity and OpenCode agents. Each role in `~/.claude/agents` (or Antigravity `team-*` plugins) has a fixed desk;
characters type, wait, or sleep based on hook events.

## Quick start (Windows)

You need **Windows 10/11** and **[Node.js 22 or newer](https://nodejs.org/)**. Nothing else is required for the browser version.
Check Node with `node --version`.

### 1. Download

**Easiest:** open the [latest release](https://github.com/alifgunadi/alifgunadi-office/releases/latest), download `AlifGunadiOffice-<version>-win-x64.zip`
and extract it to a folder you will keep (for example `C:\Tools\AlifGunadiOffice`). It already contains the desktop app (`desktop\app\AlifGunadiOffice.exe`,
no .NET install needed) and a `START-HERE.txt`. Windows SmartScreen may warn because the app is not code-signed: choose **More info → Run anyway**.
Then continue with step 2 below; skip the "desktop app" build step.

**From source**, pick one:

```powershell
git clone https://github.com/alifgunadi/alifgunadi-office.git
cd alifgunadi-office
```

or, without Git: open <https://github.com/alifgunadi/alifgunadi-office>, choose **Code → Download ZIP**, extract it somewhere you will keep
(for example `C:\Tools\alifgunadi-office`) and open PowerShell in that folder. Keep the folder: the hooks point at it.

### 2. Install (connect your agents)

```powershell
node install.js --dry-run     # optional: preview what it will change
node install.js               # connects Claude Code, Antigravity and OpenCode (whichever you have)
```

It is safe to run twice and backs up every file it edits. Restart your agents afterwards so they load the hooks.
There is nothing to `npm install`.

### 3. Open the office

```powershell
powershell -File start-office.ps1     # starts the server in the background and opens your browser
```

Start a Claude Code session and the agents appear at their desks. Stop with `powershell -File stop-office.ps1` or Stop in the gear menu of the page.
The server also starts by itself at the beginning of every Claude Code session.

### Optional: desktop app (own window, Desktop and Start Menu icon)

With the release ZIP the app is already built: double-click `desktop\app\AlifGunadiOffice.exe`, or only run the shortcut line below.
From source you build it once with the [.NET 10 SDK](https://dotnet.microsoft.com/download) (the WebView2 Runtime is already part of Windows 11):

```powershell
dotnet publish desktop\host-dotnet -c Release -o desktop\app
powershell -ExecutionPolicy Bypass -File desktop\install-shortcut.ps1
```

Then double-click **AlifGunadi Office**. More in [desktop/README.md](desktop/README.md).

### Optional: start every time you log in

```powershell
powershell -File install-autostart.ps1      # remove with uninstall-autostart.ps1
```

### Update or uninstall

- **Update:** `git pull` (or download the ZIP again), then `node install.js` and restart the office (Restart in the gear menu of the page). Rebuild the desktop app only if `desktop\` changed.
- **Uninstall:** run `stop-office.ps1`, `desktop\uninstall-shortcut.ps1` and `uninstall-autostart.ps1` if you used them, remove the AlifGunadi Office entries from `~/.claude/settings.json` (or restore the `.bak-<timestamp>` file `install.js` made), then delete the folder.

### Something does not work?

- Nothing on the page: open <http://127.0.0.1:4317/health>. If it does not answer, run `node server.js` in the folder and read the message; the log is `%TEMP%\alifgunadi-office.log`.
- Port 4317 is taken: see [Change port](#change-port).
- Desks do not move: restart the agent after `node install.js`, and see the notes for each agent below.
- Running agents from the page is **off by default**; see [Starting tasks from the page](#starting-tasks-from-the-page-optional-off-by-default) and read [SECURITY.md](SECURITY.md) first.

## Files
- `server.js`  - local server (127.0.0.1:4317), no dependencies. Runs with `node` or `bun`.
- `lib/`       - the office model (`office.js`), input cleaning (`sanitize.js`), shared paths and log rotation, and the installer logic.
- `hook.js`    - Claude Code hook. Forwards a minimal event to the server. Always exits 0, prints nothing.
- `public/` - the office page (`index.html`, `app.css`, `js/*.js`). `fonts/` holds the bundled Nunito font (SIL OFL), so the page loads nothing from other sites.
- `SECURITY.md` - what the server protects against, what it does not, and how to report a problem.
- `ensure-server.js` - starts the server in the background if it is not running (silent, idempotent).
- `install.js` - connects this checkout to Claude Code, Antigravity and OpenCode (see below).
- `hooks-settings-snippet.json` - hooks template used by `install.js` (`__ALIFGUNADI_OFFICE_ROOT__` is replaced by this checkout's path).
- `adapters/` - the Antigravity hook adapter and the OpenCode plugin.
- `docs/event-schema.json` - the `POST /event` contract for anything that wants to report to the office.
- `test/` - `npm test` runs the Node tests (no install needed).
- `start-office.ps1` / `stop-office.ps1` - start in the background and open the browser / stop.
- `install-autostart.ps1` / `uninstall-autostart.ps1` - optional Windows logon task.

## Connecting to Claude Code, Antigravity and OpenCode

Run `node install.js` from this folder. It is safe to run again: nothing changes the second time, any file it modifies
is first copied to `<file>.bak-<timestamp>`, and files with comments or other non-JSON content are left alone with an error.
Preview first with `node install.js --dry-run`; pick targets with `--target claude,antigravity,opencode`.
Restart the agents afterwards so they reload their hooks.

| Target | What it writes |
|---|---|
| `claude` | Merges the hooks from `hooks-settings-snippet.json` into `~/.claude/settings.json`. Your other settings and hooks are kept; an existing AlifGunadi Office hook that points at another folder is moved to this one. |
| `antigravity` | `agy-office-hook.js` and the `alifgunadi-office` entry of `hooks.json` in `~/.gemini/config/plugins/migrated-settings/` (other plugins' entries are kept). |
| `opencode` | `~/.config/opencode/plugins/alifgunadi-office.js`. OpenCode loads every file in that folder; no entry in `opencode.json` is needed. |

The adapters find this checkout through the path `install.js` writes into them, or through the `ALIFGUNADI_OFFICE_ROOT` environment variable.

### Claude Code
On `SessionStart`, `ensure-server.js` starts `server.js` if it is not already running, and `hook.js` forwards the lifecycle events
(`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`,
`TeammateIdle`, `Stop`, `StopFailure`, `SessionEnd`) to `http://127.0.0.1:4317/event`.

The hooks run synchronously on purpose. Claude Code's `async` option does not document the order of async hooks, and a
`Stop` that overtakes a `PreToolUse` would leave a desk stuck on "working". `PostToolUse` is not hooked: it would double the
number of processes started per tool call for no extra state.

### Antigravity
Antigravity uses plugin-scoped `hooks.json` with camelCase stdin payloads (`hookEventName`, `conversationId`, `toolCall`) and expects JSON on stdout.
The adapter subscribes to `SessionStart`, `PreInvocation`, `PostToolUse` (matcher `".*"`) and `Stop`:
- `SessionStart`: start the server (detached) and post `SessionStart`; print `{}`.
- `PreInvocation`: post `UserPromptSubmit` for `main`; print `{}`.
- `PostToolUse`: post `PreToolUse` / `PostToolUseFailure` for `main` (never `PreToolUse` in `hooks.json`, so tool permission prompts are not altered). When `toolCall.name === "invoke_subagent"`, also post `SubagentStart` with `agent_type: toolCall.args.TypeName`; print `{}`.
- `Stop`: post `SubagentStop` for any active subagents tracked in that `conversationId`, then `Stop` for `main`; print `{"decision":"stop"}`.

### OpenCode (V2)
The plugin must `export default { id: "alifgunadi-office", setup(ctx) { ... } }`; the V2 loader rejects a default export
without `id` plus `setup` (or `effect`). Inside `setup(ctx)` it translates OpenCode events into the same payloads and POSTs them:

| OpenCode source | AlifGunadi Office event |
|---|---|
| `ctx.event.subscribe`: `session.created` / `session.deleted` | `SessionStart` / `SessionEnd` |
| `session.execution.started` | `UserPromptSubmit` |
| `session.execution.succeeded` / `failed` / `interrupted` | `Stop` |
| `permission.asked` / `form.created` | `Notification` (`permission_prompt` / `idle_prompt`) |
| `ctx.tool.hook("execute.before")`, tool `task` | `SubagentStart` (`agent_type` = basename of `subagent_type`) |
| `ctx.tool.hook("execute.after")`, tool `task` | `SubagentStop` |
| `ctx.tool.hook("execute.before")`, other tools | `PreToolUse` |

On load the plugin starts the server with `spawn("node", [".../ensure-server.js"])`. It uses `"node"`, not `process.execPath`:
inside OpenCode `process.execPath` is the `opencode` binary and fails with `ENOTDIR`.
Check `~/.local/share/opencode/log/opencode.log` for `alifgunadi-office` if no desk moves.

Notes:
- Nested agent IDs map to the flat desk id: `engineering/lead-dba` becomes `lead-dba`, so the agent file name must match `ROLE_IDS` in `lib/office.js`.
- Tool calls made inside an OpenCode subagent currently show on the `main` desk, not the subagent desk.
- Claude Code, Antigravity and OpenCode can all report to the same server at once. Sessions are told apart by `source` plus session id.

### Other senders
`docs/event-schema.json` describes the event body. Send it with the header `X-AlifGunadi-Office: 1` to `http://127.0.0.1:<port>/event`.
`v` and `source` are optional (default: `1`, `claude-code`). Unknown fields are ignored, never stored.

## Privacy
`hook.js` and the adapters forward only: event name, session/agent ids, agent type, tool name, the file's base name (no directory),
the program name of a shell command (no `VAR=value` prefixes, directories or arguments), and a search pattern (max 40 chars).
Never prompts, file contents, or full commands. The server binds to 127.0.0.1 only, checks the `Host` and `Origin` headers, and rejects
requests without the `X-AlifGunadi-Office` header, so web pages in your browser cannot read or inject events. It also drops every field it does not know.

## Starting tasks from the page (optional, off by default)
The prompt dock normally runs as a **simulation**. To let it really run an agent, switch the runner on in the server's environment and
open the office through `start-office.ps1` or the desktop app (they log you in with a per-user token):

```powershell
$env:ALIFGUNADI_OFFICE_RUNNER = "claude"                                   # or "custom", see SECURITY.md
$env:ALIFGUNADI_OFFICE_WORKSPACES = "alifgunadi-office=C:\projects\alifgunadi-office;docs=C:\projects\docs"
powershell -File stop-office.ps1; powershell -File start-office.ps1   # restart so the server sees them
```

Instead of a fixed list you can leave `ALIFGUNADI_OFFICE_WORKSPACES` out: then every sub-folder of a **parent folder** is a folder to work in. Pick
the parent folder in **Pengaturan** (the gear in the header, then "Folder induk", or "Ubah folder induk…" in the Folder menu), or set `ALIFGUNADI_OFFICE_ROOTS`; until
you do there is no folder to run in. This checkout itself is never offered. New project folders show up without a restart.

Links to Jira, Figma and Penpot in a prompt can be read by the server as read-only context (set the tokens, see [SECURITY.md](SECURITY.md)); they show as chips under the input and in the Konteks tab.

The task list is kept across restarts (tasks that were open come back as "Terputus"; nothing is run again).

The dock then lists those folders and runners, tasks come from the server, and a card can show the program's output and cancel it.
`claude` runs read-only (`--permission-mode plan`) unless `ALIFGUNADI_OFFICE_RUNNER_PERMISSION` says otherwise. Read
[SECURITY.md](SECURITY.md) first: this is the one feature that runs programs for you.

## Behavior if the server is not running
The hook fails silently in a few milliseconds. Claude Code is not affected.

## Desk mapping
- Subagent events (`SubagentStart`/`SubagentStop`) use `agent_type` = the agent's `name` frontmatter.
- Tool events go to the subagent desk when Claude Code includes `agent_id`/`agent_type`, otherwise to "AlifGunadi".
- Unknown agent types (e.g. `Explore`, `general-purpose`, teammates) get a guest desk automatically (at most 12 at a time).

## Change port
Set `ALIFGUNADI_OFFICE_PORT` in both the server environment and the `env` section of `settings.json`.

## Auto start
1. On Claude Code start (recommended): the `SessionStart` hook runs `ensure-server.js`, which starts
   the server hidden in the background if it is not already running. It does not open a browser; use
   `start-office.ps1` or the desktop app for that.
2. On Windows logon (optional): run `install-autostart.ps1` once. Remove with `uninstall-autostart.ps1`.
3. Stop the server: use Stop in the gear menu of the page, `stop-office.ps1`, or
   `Get-NetTCPConnection -LocalPort 4317 -State Listen | % { Stop-Process -Id $_.OwningProcess }`.

## Auto stop
The server stops 30 seconds after the last session ends (`SessionEnd`).
Any new session or event within that window cancels the stop. Sessions with no events for 6 hours
are treated as ended (covers crashed sessions). If the server is down when you submit a prompt,
`hook.js` starts it again. Disable auto stop with environment variable `ALIFGUNADI_OFFICE_AUTO_STOP=0`.

## Logs and health
Server output is written to `%TEMP%\alifgunadi-office.log`. When it exceeds 1 MiB it is moved to `alifgunadi-office.log.1`
the next time the server is started (one old generation is kept). `ALIFGUNADI_OFFICE_DEBUG=1` adds one line per event
(names and ids only). `GET /health` returns `{ ok, app, schema, uptime_s, desks, sessions, clients }`.
`ALIFGUNADI_OFFICE_DATA_DIR` moves the log and the stop marker somewhere else (the tests use it).

## Restart / Stop from the page
Both are in the gear menu (Pengaturan) in the header, with "Folder induk" for the settings dialog.
- **Restart**: the server starts a fresh instance (new code) and the page reloads automatically.
- **Stop**: the server stops and stays stopped (prompts in an open session will not revive it)
  until a new Claude Code session starts or you run `start-office.ps1`.
  A marker file `%TEMP%\alifgunadi-office.stopped` records the manual stop.
- Start cannot be a button: the page itself is served by the server.
