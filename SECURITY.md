# Security

AlifGunadi Office is a local tool: the server listens on `127.0.0.1` only and keeps everything in memory. The one opt-in exception is
Tailscale (see [Reaching the office from your phone](README.md#reaching-the-office-from-your-phone-tailscale)).

## Reporting a problem

Open a private security advisory on the GitHub repository (Security tab, "Report a vulnerability"), or contact the maintainer
directly. Please do not post details in a public issue first.

## What the server defends against

- **Other web pages in your browser:** every route rejects a foreign `Host` (DNS rebinding), a foreign `Origin` and
  `Sec-Fetch-Site: cross-site`. `POST` routes also require the header `X-AlifGunadi-Office: 1`.
- **Malformed or hostile events:** `/event` bodies are limited to 64 KiB and reduced to a fixed allowlist of fields with type
  and length checks. Unknown fields are never stored. Guest desks (12), SSE clients (16) and tracked ids (256) are capped.
- **Page injection:** the page is served with a Content-Security-Policy that allows only scripts and styles from its own origin
  (no inline script or style), its own fonts and its own origin; plus `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
  `frame-ancestors 'none'`. The page loads nothing from other sites (the Nunito font is bundled in `fonts/`).
- **Privacy:** hooks and adapters send only event names, ids, tool names, file base names, program names and short search
  patterns. Never prompts, file contents or full command lines.
- **Desktop host:** only the office origin may load; downloads, permission requests, new windows, frames, host objects, web
  messages and script dialogs are blocked.

## Starting agents from the page (the runner)

The page can send a prompt to the server, which runs it as a program on this PC. That is the one thing in AlifGunadi Office that does more
than show activity, so it is **off by default** and strict when on.

- **Off unless you switch it on** in the server's environment: `ALIFGUNADI_OFFICE_RUNNER=claude` (or `custom`), and at least one folder (see
  **Which folders** below). Without the runner, `POST /prompts` answers 409 and the page stays a viewer with the simulation.
- **Login with a per-user token.** The server makes a random 256-bit token in `%LOCALAPPDATA%\AlifGunadiOffice\token` (or
  `ALIFGUNADI_OFFICE_TOKEN_FILE`), readable by your account. `start-office.ps1` and the desktop app open the page with the token in the
  address fragment (`/#token=...`); the page posts it to `/auth`, removes it from the address bar and receives a session cookie
  (`HttpOnly`, `SameSite=Strict`). The cookie is a random session id the server keeps in memory: it lasts 12 hours, every login is a
  new one, and a server restart ends all of them, so a cookie that leaks stops working soon. The token itself is never in a cookie or in
  an HTTP request line. Other Windows accounts cannot read your profile, so they cannot log in. There is deliberately no lockout after
  wrong tokens: 256 bits cannot be guessed, and a lockout would only let any local process keep you out.
- **What needs the login:** `POST /prompts`, `GET /tasks`, `GET /tasks/:id/output`, `POST /tasks/:id/cancel`, `GET /workspaces`, `GET /settings`, `POST /settings/check` and `/settings/root`, `POST /integrations/resolve`, the `tasks` in the
  event stream (a stream is closed when its session ends), and, while the runner is on, `POST /control/stop` and `/control/restart`
  (they end every running task; `stop-office.ps1` falls back to stopping the process). `/state` and anonymous streams never contain prompts or tasks. Writes still need `X-AlifGunadi-Office: 1` and the
  Host/Origin/Sec-Fetch checks, so another web page cannot use your cookie.
- **The page cannot choose what runs.** It sends the prompt text, a folder *id* and a runner *id*. The program and its arguments are
  fixed by the server (`claude -p --output-format text --permission-mode <mode>`), the folder is looked up by id and checked again at
  every run (absolute, real path, not a drive root or system folder), and the targets are read from the text by the server.
- **No shell, ever.** The program is started with `shell: false`; the prompt travels over stdin, so shell characters and quotes in a
  prompt are plain text. Tests run these as canaries.
- **Permission mode of claude:** `plan` (read-only) by default; `ALIFGUNADI_OFFICE_RUNNER_PERMISSION` may select `dontAsk`, `acceptEdits` or
  `auto`. `bypassPermissions` and anything else is refused (falls back to `plan`). Choosing a mode that edits files is your decision:
  a prompt can then change files in the chosen folder.
  Checked against a real `claude` (2026-11-21): in `plan` mode a run in a test folder read a file, answered, exited 0 and changed nothing.
  Also checked against a real `claude` (2026-11-23): one prompt addressed to two desks ran as two parallel tasks that both read the folder and answered,
  and in `acceptEdits` mode a run created exactly the one file it was asked to, inside the chosen folder and nowhere else. `auto` and `dontAsk` have only been
  exercised with the stand-in program so far.
- **Which folders.** The page names a folder only by id; the server turns the id into a path and checks it again at every run.
  The folders come from one of these, strongest first: (1) `ALIFGUNADI_OFFICE_WORKSPACES=name=C:\path;other=D:\path`, a fixed list that
  the page cannot change; (2) a **parent folder chosen in the Settings dialog** (saved in `%LOCALAPPDATA%\AlifGunadiOffice\settings.json`, or
  `ALIFGUNADI_OFFICE_SETTINGS_FILE`, outside the repository); (3) the first entry of `ALIFGUNADI_OFFICE_ROOTS`. **By default there are none**: until
  you choose a parent folder, the dock has no folder to run in. With (2) and (3) every ordinary sub-folder of the parent folder is a
  workspace (not names that start with a dot, `node_modules`, links, more than 200, or **this checkout**, so a prompt cannot edit
  `hook.js` and friends, which Claude Code runs in every session). **Opt-in:** `ALIFGUNADI_OFFICE_ALLOW_CHECKOUT=1` lifts that last rule so
  agents can work on this program's own code. In `plan` mode that is read-only and harmless; with an edit mode (`acceptEdits`, `auto`,
  `dontAsk`) a prompt can change `hook.js`, `ensure-server.js` and the server, which then run as you in every Claude Code session, so review
  every change (the repository is under git) before you restart anything. The server says which of the two it is in its log at start. In `plan` mode a run is read-only; with an edit mode it is not, so
  choose a parent folder that holds only what you want to expose, or use a fixed list.
  **Choosing the folder is a power of the login.** Anyone holding the session cookie can point the runner at another parent folder
  (the accepted risk of a replayed cookie, see below, now includes that). If you do not want the page to have it, set
  `ALIFGUNADI_OFFICE_WORKSPACES`: the choice is then locked and the dialog is read-only.
  A chosen parent folder must be a real folder you can read. It is refused as `too_broad` when it is a drive root, a system folder, the
  home folder or anything above it, another profile (`C:\Users\*`), `AppData`, `Documents`, `Desktop`, `Downloads` or `OneDrive` of the home folder,
  or anything inside a folder whose name starts with a dot (`.ssh`, `.aws`). Paths are compared by their real, long name (the native
  `realpath`), so a short 8.3 spelling such as `C:\PROGRA~1` gets no further than the long one. A UNC or device path (`\\host\share`) is refused
  before the disk is touched, so the server never contacts another machine for it. A sub-folder swapped for a link that leads out of
  the parent folder is refused at run time. At most 5000 entries of a folder are read, `POST /settings/check` is limited to 60 a
  minute, and it answers only a code and, for an acceptable folder, a count. The path is only ever sent in a POST body.
  The settings file is trusted like the token file: another process of your own account can edit it (and can read the token anyway).
  A file that cannot be read or understood means **no folders** (not a wider default) until a folder is chosen again.
  Between the run-time check and the start of the program a folder could still be swapped for a link by someone who can write to the
  parent folder; that needs the access this program already trusts you with. The dialog only lists and chooses folders; it never runs anything.
- **Context from links (Jira, Figma, Penpot).** Off unless a token is set in the server's environment: `JIRA_EMAIL`, `JIRA_API_TOKEN` and
  `JIRA_SITE` (your own site, e.g. `acme.atlassian.net`), `FIGMA_ACCESS_TOKEN`, `PENPOT_ACCESS_TOKEN` (and `PENPOT_BASE_URL` for a
  self-hosted Penpot). When a prompt holds such a link, the server (never the page) reads it, read-only, and puts a few short fields in front of the
  prompt for the program. The server's side of this is strict: a link is parsed and matched against **fixed hosts** (your Jira site only, `api.figma.com`,
  `design.penpot.app` or exactly the host in `PENPOT_BASE_URL`), and the API address is built by the server, never taken from the link; HTTPS only
  (a self-hosted Penpot may be `http`, which sends its token in clear: your choice); the address a host name resolves to is checked and the connection
  is made to that checked address, so a private, loopback, link-local, carrier-grade, documentation or translation address is refused (except for the
  Penpot host you named); no redirect is followed, a whole request may take 8 seconds and 256 KiB, at most 8 requests run at once and the same question
  is asked once; each token goes only to its own provider and is never in a result, a log, the page, `/state` or the program's environment.
  A Jira link to any other Atlassian site is **not** read, because an API token works for every site of the account and would otherwise go to
  whoever registered one. `POST /integrations/resolve` and `urls` in `POST /prompts` need the login, the header and the usual origin checks; the
  server asks again for the links of a prompt itself, so the page cannot attach context it made up. Answers are kept 5 minutes (failures 30 seconds) in
  memory, limited to 30 resolve requests a minute and 10 links each; nothing of it is saved to disk or shown in the Tasks tab.
  **Residual risk: prompt injection.** The title of a Jira issue or a Figma file can be written by someone else, and it goes to a program that may edit
  files. The text is cut short (200 characters), invisible and control characters are replaced, each item is one escaped JSON line without square
  brackets, the block ends with an end line, and the prompt you typed follows under its own label ("Perintah pengguna:"). That lowers the risk and
  cannot remove it. Use `plan` mode (the default) when you attach links you do not control, and treat a link like any other text you paste into a prompt.
- **The task list on disk.** So that a restart does not make the Tasks tab forget, the server keeps the task list (ids, desk, folder id,
  runner, status, times, exit code, a short error and **the prompt text**, but never the output) in `alifgunadi-office-tasks.json` in the data
  folder (`ALIFGUNADI_OFFICE_DATA_DIR`, by default the temp folder of your account), created readable by you only where the system knows modes.
  It is written at most twice a second and when the server stops. Because it holds your prompts, treat it like the log: delete it to
  forget them. What is read back is checked field by field (ids, statuses, lengths; unknown fields and odd values are dropped), tasks
  older than a week and anything over 100 tasks or 1 MiB are not kept, and a task that was queued or running when the server went away
  comes back as "interrupted": nothing is run again after a restart. A file that cannot be read or understood is set aside as `.bad` with a
  warning, and a disk that is full or locked only produces a warning. The page also keeps its Folder, its Runner and the text you were
  typing in this browser's `localStorage` (`alifgunadi-office.dock`, never sent anywhere; it is shown as text, never as markup).
- **Limits:** one running task per desk, 3 programs at once, 10 minutes each (the whole process tree is killed; a program that does
  not end after the kill is given up after 8 seconds), 40 open tasks in all, 64 KiB of output kept, 4000 characters per prompt, 20
  prompts a minute, 40 desks per prompt (each desk is a separate run of the prompt, which costs API usage). The office does not
  auto-stop while a task runs.
- **Environment of the program:** a short allowlist (PATH, profile and temp folders, `ANTHROPIC_*`, `CLAUDE_*`; more names via
  `ALIFGUNADI_OFFICE_RUNNER_ENV`), plus `ALIFGUNADI_OFFICE_PORT` and `ALIFGUNADI_OFFICE_DATA_DIR` (not secrets) so hooks inside a task report to this
  office. Every other `ALIFGUNADI_OFFICE_*` setting and variable of the server is left out.
- **Hooks of the folder:** `claude -p` does not ask whether to trust a folder, so hooks in that folder's `.claude/settings.json` run.
  Only offer folders you trust, whether in `ALIFGUNADI_OFFICE_WORKSPACES` or as the sub-folders of a parent folder: a repository cloned next to your
  projects becomes a place a prompt can run its hooks.
- **Stopping:** Stop, Restart and a normal exit end every program the server started. If the server process is killed hard
  (`taskkill /F`, a crash), a running program may outlive it until it finishes or reaches its timeout.
- Only `claude` and a `custom` program (`ALIFGUNADI_OFFICE_RUNNER_CMD` absolute path, `ALIFGUNADI_OFFICE_RUNNER_ARGS` JSON array) exist for now; the
  runner has been exercised with a stand-in program in tests, not against a real claude account.

## What it does not defend against

- **Other local users and processes, for the viewer.** Without the runner there is no authentication for events or state: any
  process on this machine can post events or read the state, and the `X-AlifGunadi-Office` header is not a secret. Starting agents is the
  part that is protected (above). Another process **of your own account** can read your token file, so it can log in too: the token
  protects against other accounts and other web pages, not against code already running as you. Do not expose the port beyond
  `127.0.0.1`, with one exception: `ALIFGUNADI_OFFICE_LISTEN` accepts **Tailscale addresses only** (100.64.0.0/10). A wildcard, a LAN
  address or any other value is refused and reported, so the office cannot be opened to the whole Wi-Fi by a typo. Over the tailnet
  the same rules apply as on this computer: the viewer has no login, so every device and person on your tailnet can read the state and
  post events. Keep the tailnet to your own devices (no shared nodes, no subnet routers pointing at the port, no Tailscale Funnel).
  Traffic between tailnet devices is encrypted by Tailscale; the office itself still speaks plain HTTP on that link. `/auth` and the
  token work the same way, so type the token on a phone only if you accept that device holding a 12-hour session.
- **Someone else holding the port.** The launchers hand the token to whatever answers on the office's port. If another account (or a
  rogue process) started a server on that port before yours, it serves the page and so can read the token from the address the
  launcher opened. A proof such as an HMAC would not help, because the page that computes it comes from the same server. Keep the port
  yours: start the office before anything else, or set a different `ALIFGUNADI_OFFICE_PORT` on a shared PC. The token is also on the command
  line of the launched browser while it starts (visible to your own account only) and in the browser's record of the launched address.
- **Cookies are not port-isolated.** Browsers send the session cookie to every port on 127.0.0.1, so a local web service you visit in
  that browser can see it. It is only valid for at most 12 hours, only until the next restart, and a page on another origin still cannot
  use it from the browser (Host, Origin, `Sec-Fetch-Site` and `SameSite=Strict` checks), but a rogue local *server* can replay it with a
  non-browser client. Do not run untrusted services on localhost while logged in, and restart the office to end all sessions.
- **A hard-killed server** (`taskkill /F`, a crash) may leave a running program behind; there is no Windows job object yet.
- **Write access to the checkout.** Claude Code runs `hook.js` and `ensure-server.js` from this folder with your rights, so
  anyone who can write to the folder can run code as you. On a PC shared between Windows accounts, keep the repo where only
  you can write, for example under your user profile, or remove the broad grant on the parent folder:

  ```powershell
  # Review first: icacls C:\projects
  icacls C:\projects\alifgunadi-office /inheritance:d
  icacls C:\projects\alifgunadi-office /remove "NT AUTHORITY\Authenticated Users"
  ```

  (Default Windows permissions on `C:\` let every signed-in user modify new top-level folders.)
- **Supply chain.** There are no runtime dependencies. Dev tooling is pinned in CI and kept current by Dependabot.

## Hardening switches

- `ALIFGUNADI_OFFICE_RUNNER`, `ALIFGUNADI_OFFICE_WORKSPACES`, `ALIFGUNADI_OFFICE_RUNNER_PERMISSION`, `ALIFGUNADI_OFFICE_RUNNER_CMD`, `ALIFGUNADI_OFFICE_RUNNER_ARGS`,
  `ALIFGUNADI_OFFICE_RUNNER_ENV`, `ALIFGUNADI_OFFICE_TOKEN_FILE`: see above. The server must be restarted to pick them up.
- `ALIFGUNADI_OFFICE_ROOTS` (parent folder of the workspaces), `ALIFGUNADI_OFFICE_SETTINGS_FILE` (where the page saves its choice) and `ALIFGUNADI_OFFICE_HOME` (which
  folder counts as the home folder in the `too_broad` check; for tests and unusual layouts): see **Which folders**.
- `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_SITE`, `FIGMA_ACCESS_TOKEN`, `PENPOT_ACCESS_TOKEN`, `PENPOT_BASE_URL`: links as context, see **Context from links**.
- `ALIFGUNADI_OFFICE_PORT` changes the port. `ALIFGUNADI_OFFICE_DATA_DIR` moves the log and the stop marker.
- `GET /health` reports liveness without exposing event content.
