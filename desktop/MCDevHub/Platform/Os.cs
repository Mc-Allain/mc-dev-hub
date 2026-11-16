using System;
using System.Diagnostics;
using System.IO;

namespace MCDevHub.Platform;

/// <summary>Small OS helpers that differ between Windows and macOS.</summary>
public static class Os
{
    const string AppName = "MCDevHub";

    public static void OpenUrl(string url) => Shell(url);

    public static void OpenFolder(string path)
    {
        Directory.CreateDirectory(path);
        Shell(path);
    }

    static void Shell(string target)
    {
        try
        {
            if (OperatingSystem.IsMacOS()) Process.Start("open", target);
            else if (OperatingSystem.IsLinux()) Process.Start("xdg-open", target);
            else Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch { /* nothing sensible to do */ }
    }

    static string ExePath => Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, AppName + ".exe");

    /// <summary>Start with Windows (HKCU Run key) / macOS login (LaunchAgent).</summary>
    public static void SetStartWithSystem(bool enable)
    {
        try
        {
#if WINDOWS
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
            if (key == null) return;
            if (enable) key.SetValue(AppName, $"\"{ExePath}\" --minimized");
            else if (key.GetValue(AppName) != null) key.DeleteValue(AppName);
#else
            if (!OperatingSystem.IsMacOS()) return;
            var plist = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "LaunchAgents", "com.mc.devhub.plist");
            if (!enable) { if (File.Exists(plist)) File.Delete(plist); return; }
            Directory.CreateDirectory(Path.GetDirectoryName(plist)!);
            File.WriteAllText(plist, $@"<?xml version=""1.0"" encoding=""UTF-8""?>
<!DOCTYPE plist PUBLIC ""-//Apple//DTD PLIST 1.0//EN"" ""http://www.apple.com/DTDs/PropertyList-1.0.dtd"">
<plist version=""1.0""><dict>
  <key>Label</key><string>com.mc.devhub</string>
  <key>ProgramArguments</key><array><string>{ExePath}</string><string>--minimized</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>");
#endif
        }
        catch { /* registry/file not writable: leave it */ }
    }

    /// <summary>True when Windows apps are set to dark mode.</summary>
    public static bool SystemIsDark()
    {
#if WINDOWS
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int v && v == 0;
        }
        catch { return false; }
#else
        return false;
#endif
    }
}
