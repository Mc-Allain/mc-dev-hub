using System;
using System.Linq;
using System.Threading;
using Avalonia;

namespace MCDevHub;

internal static class Program
{
    const string InstanceName = "MCDevHub.SingleInstance";
    public static EventWaitHandle? ShowSignal;
    public static bool StartMinimized;

    [STAThread]
    public static int Main(string[] args)
    {
        // Only one launcher app at a time: a second start just brings the first one forward.
        using var mutex = new Mutex(true, InstanceName, out bool first);
        ShowSignal = new EventWaitHandle(false, EventResetMode.AutoReset, InstanceName + ".Show");
        if (!first)
        {
            ShowSignal.Set();
            return 0;
        }

        StartMinimized = args.Contains("--minimized");
        return BuildAvaloniaApp().StartWithClassicDesktopLifetime(args, Avalonia.Controls.ShutdownMode.OnExplicitShutdown);
    }

    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}
