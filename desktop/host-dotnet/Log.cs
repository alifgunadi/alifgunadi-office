namespace AlifGunadiOffice.Desktop;

/// <summary>Host log at %TEMP%\alifgunadi-office-desktop.log (separate from the server log).</summary>
internal static class Log
{
    private const long MaxBytes = 512 * 1024;
    private static readonly string FilePath = Path.Combine(Path.GetTempPath(), "alifgunadi-office-desktop.log");
    private static readonly object Gate = new();

    public static void Info(string message) => Write("INFO", message);

    public static void Error(string context, Exception? ex) => Write("ERROR", $"{context}: {ex}");

    private static void Write(string level, string message)
    {
        try
        {
            lock (Gate)
            {
                var info = new FileInfo(FilePath);
                if (info.Exists && info.Length > MaxBytes) info.Delete();
                File.AppendAllText(FilePath, $"[{DateTime.Now:O}] {level} {message}{Environment.NewLine}");
            }
        }
        catch (IOException)
        {
            // Logging must never break the app.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
