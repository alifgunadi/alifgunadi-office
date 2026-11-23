namespace AlifGunadiOffice.Desktop;

internal static class Program
{
    private const string MutexName = @"Local\AlifGunadiOffice.Desktop.SingleInstance";
    private const string ActivateEventName = @"Local\AlifGunadiOffice.Desktop.Activate";

    [STAThread]
    private static int Main()
    {
        using var mutex = new Mutex(initiallyOwned: true, MutexName, out bool isFirstInstance);
        if (!isFirstInstance)
        {
            // A window is already open: bring it to the front instead of opening a second WebView2 tree.
            try
            {
                using var activate = EventWaitHandle.OpenExisting(ActivateEventName);
                activate.Set();
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                // First instance is still starting; nothing to focus yet.
            }
            return 0;
        }

        using var activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ActivateEventName);

        Application.ThreadException += (_, e) => Log.Error("UI thread", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Error("Unhandled", e.ExceptionObject as Exception);

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var config = AppConfig.Resolve();
        Log.Info($"Starting. root={config.Root} port={config.Port}");

        using var form = new MainForm(config, activateEvent);
        Application.Run(form);
        Log.Info("Exited.");
        return 0;
    }
}
