using System.Text.Json;

namespace AlifGunadiOffice.Desktop;

/// <summary>Last window bounds, stored in %LOCALAPPDATA%\AlifGunadiOffice\window.json.</summary>
internal sealed class WindowSettings
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public bool Maximized { get; set; }

    public static string DataDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AlifGunadiOffice");

    private static string FilePath => Path.Combine(DataDir, "window.json");

    [System.Text.Json.Serialization.JsonIgnore]
    public Rectangle Bounds => new(X, Y, Width, Height);

    public static WindowSettings? Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            var s = JsonSerializer.Deserialize(File.ReadAllText(FilePath), WindowSettingsJson.Default.WindowSettings);
            if (s is null || s.Width < 200 || s.Height < 150) return null;
            // Only restore if the window would still be visible on a connected monitor.
            bool onScreen = Screen.AllScreens.Any(sc => Rectangle.Intersect(sc.WorkingArea, s.Bounds) is { Width: >= 100, Height: >= 50 });
            return onScreen ? s : null;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            Log.Error("Load window settings", ex);
            return null;
        }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(DataDir);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, WindowSettingsJson.Default.WindowSettings));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Error("Save window settings", ex);
        }
    }
}

[System.Text.Json.Serialization.JsonSerializable(typeof(WindowSettings))]
internal sealed partial class WindowSettingsJson : System.Text.Json.Serialization.JsonSerializerContext;
