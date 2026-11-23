# AlifGunadi Office Desktop

AlifGunadi Office as its own Windows app: one window, no browser tabs, same pixels as the browser page.

`AlifGunadiOffice.exe` is a thin C# WinForms + WebView2 host. It runs the existing `ensure-server.js`, then opens
`http://127.0.0.1:4317/` in a WebView2 window. `server.js`, `public/`, `hook.js`, and every hook config
(Claude Code, Antigravity, OpenCode) are unchanged, so all integrations keep working.

## Install

Requires the .NET 10 SDK (build), .NET 10 Desktop Runtime, Node, and the WebView2 Runtime (preinstalled on Windows 11).

```powershell
cd C:\projects\alifgunadi-office
dotnet publish desktop\host-dotnet -c Release -o desktop\app
powershell -ExecutionPolicy Bypass -File desktop\install-shortcut.ps1   # "AlifGunadi Office" on Desktop + Start Menu
```

Double-click **AlifGunadi Office** on the Desktop. Remove the shortcuts with `desktop\uninstall-shortcut.ps1`.

## Behavior

| What | Behavior |
|---|---|
| Open the app | Runs `ensure-server.js` (starts the server only if needed, clears a manual Stop), then shows the office. |
| Login | Opens the page with this user's token (`%LOCALAPPDATA%\AlifGunadiOffice\token`) in the address fragment; the page logs in and removes it. Only matters when the runner is switched on (see SECURITY.md). |
| Hooks | Unchanged. Claude Code / Antigravity / OpenCode post to the server; the app is just a viewer. |
| Close the window | The app exits; the server keeps running and still auto-stops 30 s after the last session. |
| Restart / Stop (gear menu) | Same as in the browser. After Stop, the window stays open with the original notice. |
| Server down (auto-stop, crash) | The page shows `reconnecting...` and returns to `live` by itself. |
| F5 while the server is down | No Chromium error page: a blank office background, then the office returns as soon as the server is up. |
| Second launch | Focuses the open window (single instance). |
| Minimize | WebView2 is hidden and asked to trim memory; rendering stops until restored. |
| Window size/position | Default 1600x900 CSS px (shrunk to fit the screen), then remembered in `%LOCALAPPDATA%\AlifGunadiOffice\window.json`. |
| Links / other sites | Blocked; only the office origin loads. Context menu and DevTools are off in Release builds. |
| Zoom | Same as a browser tab (Ctrl+wheel, Ctrl +/-), starts at 100%. |
| Logs | Host: `%TEMP%\alifgunadi-office-desktop.log`. Server: `%TEMP%\alifgunadi-office.log` (unchanged). |

Custom port: `ALIFGUNADI_OFFICE_PORT` must be a Windows user environment variable for the Desktop icon to see it.
The `env` block in Claude Code's `settings.json` only reaches hooks. Custom repo location: set `ALIFGUNADI_OFFICE_ROOT`.

## Tests

```powershell
node desktop\tools\test-desktop.js            # 14 end-to-end tests, isolated server on port 4399
powershell -File desktop\tools\measure-ram.ps1 -Name AlifGunadiOffice -Samples 5
```

The test runner launches the real exe, drives it through the DevTools protocol, and never touches the office on
port 4317. Screenshots, RAM numbers, and results are written to `desktop\tools\out\`.

## Layout

```
desktop/
  host-dotnet/      C# source (Program, MainForm, ServerBootstrap, AppConfig, WindowSettings, Log) + icon
  app/              build output (git-ignored): AlifGunadiOffice.exe
  tools/            make-icon.js, measure-ram.ps1, test-desktop.js
  install-shortcut.ps1 / uninstall-shortcut.ps1
```
