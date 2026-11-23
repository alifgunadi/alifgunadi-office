namespace AlifGunadiOffice.Desktop;

/// <summary>Where the AlifGunadi Office repo is and which port the server uses.</summary>
internal sealed record AppConfig(string Root, int Port)
{
    private const int DefaultPort = 4317;

    public Uri Origin => new($"http://127.0.0.1:{Port}/");

    /// <summary>
    /// The address to open: the office, plus this user's token in the fragment when there is a token file. The page trades the token for a session
    /// cookie at once and removes it from the address (the fragment is never sent to the server). Same file rule as lib/auth.js.
    /// Never log the result.
    /// </summary>
    public string StartUrl()
    {
        try
        {
            string? file = Environment.GetEnvironmentVariable("ALIFGUNADI_OFFICE_TOKEN_FILE");
            if (string.IsNullOrWhiteSpace(file))
            {
                string? local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
                if (string.IsNullOrWhiteSpace(local)) return Origin.ToString();
                file = Path.Combine(local, "AlifGunadiOffice", "token");
            }
            string token = File.ReadAllText(file).Trim();
            bool valid = token.Length == 64 && token.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f'));
            return valid ? Origin + "#token=" + token : Origin.ToString();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return Origin.ToString(); // no token (yet): the page opens as a viewer
        }
    }

    public bool HasServerScript => File.Exists(EnsureServerScript);

    public string EnsureServerScript => Path.Combine(Root, "ensure-server.js");

    public static AppConfig Resolve() => new(ResolveRoot(), ResolvePort());

    // Same rule as server.js / hook.js / ensure-server.js: Number(ALIFGUNADI_OFFICE_PORT) || 4317.
    private static int ResolvePort()
    {
        string? raw = Environment.GetEnvironmentVariable("ALIFGUNADI_OFFICE_PORT");
        return int.TryParse(raw, out int port) && port is > 0 and < 65536 ? port : DefaultPort;
    }

    // ALIFGUNADI_OFFICE_ROOT, else the first parent of the exe that contains server.js + ensure-server.js.
    private static string ResolveRoot()
    {
        string? fromEnv = Environment.GetEnvironmentVariable("ALIFGUNADI_OFFICE_ROOT");
        if (!string.IsNullOrWhiteSpace(fromEnv) && IsRepoRoot(fromEnv)) return Path.GetFullPath(fromEnv);

        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (IsRepoRoot(dir.FullName)) return dir.FullName;
        }
        // Not found: keep the exe folder. MainForm tells the user that server.js is missing and how to point at the repo.
        return AppContext.BaseDirectory;
    }

    private static bool IsRepoRoot(string dir) =>
        File.Exists(Path.Combine(dir, "server.js")) && File.Exists(Path.Combine(dir, "ensure-server.js"));
}
