using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AlifGunadiOffice.Desktop;

/// <summary>
/// One window, one WebView2, showing the existing page at http://127.0.0.1:PORT/ unchanged.
/// The server keeps running when this window closes (it is managed by hooks / auto stop as before).
/// </summary>
internal sealed class MainForm : Form
{
    // Matches --color-stage in public/tokens.css so there is no white flash before the page paints.
    private static readonly Color PageBackground = Color.FromArgb(0xdc, 0xe2, 0xeb);
    private static readonly Size DefaultClientSizeLogical = new(1600, 900);
    private static readonly TimeSpan StartupWait = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan OfflineRetry = TimeSpan.FromSeconds(2);

    private readonly AppConfig _config;
    private readonly EventWaitHandle _activateEvent;
    private WebView2 _webView = new();
    private readonly System.Windows.Forms.Timer _offlineTimer = new();
    private readonly CancellationTokenSource _closing = new();
    private RegisteredWaitHandle? _activateWait;
    private bool _showingPage;
    private bool _recovering;

    public MainForm(AppConfig config, EventWaitHandle activateEvent)
    {
        _config = config;
        _activateEvent = activateEvent;

        Text = "AlifGunadi Office";
        BackColor = PageBackground;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        using (var icon = typeof(MainForm).Assembly.GetManifestResourceStream("app.ico"))
        {
            if (icon is not null) Icon = new Icon(icon);
        }

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = PageBackground;
        Controls.Add(_webView);

        _offlineTimer.Interval = (int)OfflineRetry.TotalMilliseconds;
        _offlineTimer.Tick += async (_, _) => await RetryWhileOfflineAsync();

        ApplyInitialBounds();
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        _activateWait = ThreadPool.RegisterWaitForSingleObject(
            _activateEvent, (_, _) => BeginInvokeSafe(BringToFront), null, Timeout.Infinite, executeOnlyOnce: false);

        try
        {
            await InitializeWebViewAsync();
            bool up = await ServerBootstrap.EnsureAsync(_config, StartupWait, _closing.Token);
            if (up) ShowPage();
            else
            {
                EnterOffline("server did not answer after start");
                ExplainStartupFailure();
            }
        }
        catch (OperationCanceledException)
        {
            // Window closed during startup.
        }
        catch (Exception ex)
        {
            Log.Error("Startup", ex);
            MessageBox.Show(this,
                "AlifGunadi Office could not start the WebView2 runtime.\n\n" + ex.Message,
                "AlifGunadi Office", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private async Task InitializeWebViewAsync()
    {
        string userData = Path.Combine(WindowSettings.DataDir, "WebView2");
        // Extra browser flags can still be passed with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (used by the tests).
        var options = new CoreWebView2EnvironmentOptions();
        CoreWebView2Environment env;
        try
        {
            env = await CoreWebView2Environment.CreateAsync(browserExecutableFolder: null, userData, options);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this,
                "The Microsoft Edge WebView2 Runtime is not installed.\n\nInstall the Evergreen runtime from https://developer.microsoft.com/microsoft-edge/webview2/ and start AlifGunadi Office again.",
                "AlifGunadi Office", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            throw new OperationCanceledException();
        }
        // The runtime updates itself; a new version is used the next time the app starts.
        env.NewBrowserVersionAvailable += (_, _) => Log.Info("A newer WebView2 runtime is installed; it is used after restarting AlifGunadi Office.");
        await _webView.EnsureCoreWebView2Async(env);

        var core = _webView.CoreWebView2;
        var s = core.Settings;
#if DEBUG
        s.AreDevToolsEnabled = true;
        s.AreDefaultContextMenusEnabled = true;
#else
        s.AreDevToolsEnabled = false;
        s.AreDefaultContextMenusEnabled = false;
#endif
        s.IsStatusBarEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.IsZoomControlEnabled = true;           // Same as a browser tab (Ctrl+wheel, Ctrl +/-).
        s.AreBrowserAcceleratorKeysEnabled = true; // F5 / Ctrl+R reload must keep working.
        s.AreDefaultScriptDialogsEnabled = false; // the page never uses alert/confirm/prompt
        s.AreHostObjectsAllowed = false;          // no host object bridge into the page
        s.IsWebMessageEnabled = false;            // the page never talks to the host

        core.DocumentTitleChanged += (_, _) =>
        {
            if (_showingPage && !string.IsNullOrWhiteSpace(core.DocumentTitle)) Text = core.DocumentTitle;
        };
        core.NavigationStarting += OnNavigationStarting;
        core.NavigationCompleted += OnNavigationCompleted;
        core.FrameNavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += (_, a) => a.Handled = true;
        core.PermissionRequested += (_, a) => a.State = CoreWebView2PermissionState.Deny;
        core.DownloadStarting += (_, a) => { a.Cancel = true; a.Handled = true; };
        core.ProcessFailed += OnProcessFailed;
    }

    /// <summary>Server did not come up: say why when the cause is on this machine (no repo, no Node).</summary>
    private void ExplainStartupFailure()
    {
        string? message = null;
        if (!_config.HasServerScript)
            message = $"ensure-server.js was not found in {_config.Root}.\n\nSet the ALIFGUNADI_OFFICE_ROOT environment variable to the AlifGunadi Office folder (the one that contains server.js).";
        else if (!ServerBootstrap.NodeAvailable())
            message = "Node.js was not found on PATH, so the AlifGunadi Office server cannot start.\n\nInstall Node.js 22 or newer from https://nodejs.org/ and start AlifGunadi Office again.";
        if (message is not null) MessageBox.Show(this, message, "AlifGunadi Office", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private void ShowPage()
    {
        _offlineTimer.Stop();
        _showingPage = true;
        _webView.CoreWebView2.Navigate(_config.StartUrl());
    }

    /// <summary>Server unreachable: show only the page background and retry quietly (no new UI).</summary>
    private void EnterOffline(string reason)
    {
        Log.Info($"Offline: {reason}");
        _showingPage = false;
        _webView.CoreWebView2?.NavigateToString(
            "<!doctype html><html><head><title>AlifGunadi Office</title></head>" +
            "<body style=\"margin:0;background:#dce2eb;height:100vh\"></body></html>");
        _offlineTimer.Start();
    }

    private async Task RetryWhileOfflineAsync()
    {
        _offlineTimer.Stop();
        if (_closing.IsCancellationRequested) return;
        if (await ServerBootstrap.IsUpAsync(_config, _closing.Token)) ShowPage();
        else _offlineTimer.Start();
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        // Only the office page itself (and in-page reloads) may load in this window.
        if (e.Uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase) || e.Uri == "about:blank") return;
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) && Uri.Compare(uri, _config.Origin,
                UriComponents.SchemeAndServer, UriFormat.Unescaped, StringComparison.OrdinalIgnoreCase) == 0)
        {
            return;
        }
        Log.Info($"Blocked navigation to {e.Uri}");
        e.Cancel = true;
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!_showingPage || e.IsSuccess) return;
        // Typical after Stop + F5 while the server is down: avoid Chromium's error page, wait for the server.
        if (e.WebErrorStatus is CoreWebView2WebErrorStatus.OperationCanceled) return;
        EnterOffline($"navigation failed: {e.WebErrorStatus}");
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        Log.Info($"WebView2 process failed: {e.ProcessFailedKind} ({e.Reason})");
        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
        {
            BeginInvokeSafe(async () => await RecreateWebViewAsync());
        }
        else if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited
                 or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
        {
            BeginInvokeSafe(() => _webView.CoreWebView2?.Reload());
        }
    }

    /// <summary>The WebView2 browser process died: build a fresh WebView in the same window.</summary>
    private async Task RecreateWebViewAsync()
    {
        if (_recovering || _closing.IsCancellationRequested) return;
        _recovering = true;
        try
        {
            var old = _webView;
            Controls.Remove(old);
            old.Dispose();
            _webView = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = PageBackground };
            Controls.Add(_webView);
            await InitializeWebViewAsync();
            if (await ServerBootstrap.IsUpAsync(_config, _closing.Token)) ShowPage();
            else EnterOffline("server down after WebView2 restart");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Log.Error("Recreate WebView2", ex);
        }
        finally
        {
            _recovering = false;
        }
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        ApplyMemoryMode();
    }

    /// <summary>Minimized: hide the WebView (stops rendering) and ask WebView2 to trim memory. Visuals are unchanged when shown.</summary>
    private void ApplyMemoryMode()
    {
        if (_webView.CoreWebView2 is null) return;
        bool minimized = WindowState == FormWindowState.Minimized;
        try
        {
            if (minimized)
            {
                _webView.Visible = false;
                _webView.CoreWebView2.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Low;
            }
            else if (!_webView.Visible)
            {
                _webView.CoreWebView2.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Normal;
                _webView.Visible = true;
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            Log.Error("Memory mode", ex);
        }
    }

    private new void BringToFront()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Activate();
        base.BringToFront();
    }

    private void ApplyInitialBounds()
    {
        var saved = WindowSettings.Load();
        if (saved is not null)
        {
            Bounds = saved.Bounds;
            if (saved.Maximized) WindowState = FormWindowState.Maximized;
            return;
        }
        var screen = Screen.PrimaryScreen ?? Screen.AllScreens[0];
        float scale = DpiFor(screen) / 96f;
        var client = new Size((int)(DefaultClientSizeLogical.Width * scale), (int)(DefaultClientSizeLogical.Height * scale));
        ClientSize = client;
        var area = screen.WorkingArea;
        int w = Math.Min(Width, area.Width), h = Math.Min(Height, area.Height);
        Bounds = new Rectangle(area.Left + (area.Width - w) / 2, area.Top + (area.Height - h) / 2, w, h);
    }

    private static int DpiFor(Screen screen)
    {
        var p = new Point(screen.Bounds.Left + 1, screen.Bounds.Top + 1);
        IntPtr monitor = NativeMethods.MonitorFromPoint(p, 2 /* MONITOR_DEFAULTTONEAREST */);
        return NativeMethods.GetDpiForMonitor(monitor, 0, out uint dpiX, out _) == 0 ? (int)dpiX : 96;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _closing.Cancel();
        _offlineTimer.Stop();
        var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        new WindowSettings
        {
            X = b.X, Y = b.Y, Width = b.Width, Height = b.Height,
            Maximized = WindowState == FormWindowState.Maximized,
        }.Save();
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _activateWait?.Unregister(null);
            _offlineTimer.Dispose();
            _webView.Dispose();
            _closing.Dispose();
        }
        base.Dispose(disposing);
    }

    private void BeginInvokeSafe(Action action)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try
        {
            BeginInvoke(action);
        }
        catch (InvalidOperationException)
        {
            // Window is closing.
        }
    }
}

internal static class NativeMethods
{
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    internal static extern IntPtr MonitorFromPoint(Point pt, uint flags);

    [System.Runtime.InteropServices.DllImport("shcore.dll")]
    internal static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);
}
