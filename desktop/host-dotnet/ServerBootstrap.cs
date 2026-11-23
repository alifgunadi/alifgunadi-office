using System.Diagnostics;

namespace AlifGunadiOffice.Desktop;

/// <summary>Starts the existing Node server through ensure-server.js (same as start-office.ps1) and probes /state.</summary>
internal static class ServerBootstrap
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(1) };

    public static async Task<bool> IsUpAsync(AppConfig config, CancellationToken ct = default)
    {
        try
        {
            using var res = await Http.GetAsync(new Uri(config.Origin, "/state"), ct).ConfigureAwait(false);
            return res.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return false;
        }
    }

    /// <summary>Runs ensure-server.js, then waits up to <paramref name="wait"/> for the server to answer.</summary>
    public static async Task<bool> EnsureAsync(AppConfig config, TimeSpan wait, CancellationToken ct = default)
    {
        RunEnsureServer(config);
        var deadline = DateTime.UtcNow + wait;
        while (DateTime.UtcNow < deadline)
        {
            if (await IsUpAsync(config, ct).ConfigureAwait(false)) return true;
            await Task.Delay(200, ct).ConfigureAwait(false);
        }
        return false;
    }

    private static void RunEnsureServer(AppConfig config)
    {
        if (!File.Exists(config.EnsureServerScript))
        {
            Log.Info($"ensure-server.js not found at {config.EnsureServerScript}");
            return;
        }
        string? node = FindNode();
        if (node is null)
        {
            Log.Info("node.exe not found on PATH");
            return;
        }
        try
        {
            var psi = new ProcessStartInfo(node)
            {
                WorkingDirectory = config.Root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
            };
            psi.ArgumentList.Add(config.EnsureServerScript);
            psi.Environment["ALIFGUNADI_OFFICE_PORT"] = config.Port.ToString();
            using var p = Process.Start(psi);
            if (p is null) return;
            p.StandardInput.Close(); // ensure-server.js reads stdin (hook payload); give it EOF.
            if (!p.WaitForExit(5000)) Log.Info("ensure-server.js did not exit within 5s");
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Log.Error("ensure-server.js", ex);
        }
    }

    public static bool NodeAvailable() => FindNode() is not null;

    private static string? FindNode()
    {
        string? path = Environment.GetEnvironmentVariable("PATH");
        if (path is not null)
        {
            foreach (string dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    string candidate = Path.Combine(dir.Trim('"'), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch (ArgumentException)
                {
                    // Malformed PATH entry.
                }
            }
        }
        string programFiles = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        return File.Exists(programFiles) ? programFiles : null;
    }
}
