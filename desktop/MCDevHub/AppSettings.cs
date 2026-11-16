using System;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace MCDevHub;

public enum UiMode { AppWindow, Browser }

/// <summary>Desktop app settings, stored in %APPDATA%\MCDevHub\settings.json (~/Library/Application Support on macOS).</summary>
public sealed class AppSettings
{
    public int Port { get; set; } = 4800;
    public UiMode OpenUiIn { get; set; } = UiMode.AppWindow;
    public bool StartServerOnLaunch { get; set; } = true;
    public bool OpenUiOnStart { get; set; } = true;
    public bool StartWithSystem { get; set; }
    public bool CloseToTray { get; set; } = true;
    public string NodePath { get; set; } = "";
    public string ServerDir { get; set; } = "";
    public string DataDir { get; set; } = "";
    public string Theme { get; set; } = "System";

    // remembered size of the web UI window
    public int UiWidth { get; set; } = 1360;
    public int UiHeight { get; set; } = 880;
    public bool UiMaximized { get; set; }

    public static string Folder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "MCDevHub");
    static string FilePath => Path.Combine(Folder, "settings.json");
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true, PropertyNameCaseInsensitive = true };

    public static AppSettings Load()
    {
        AppSettings s;
        bool firstRun = !File.Exists(FilePath);
        try
        {
            s = firstRun ? new() : JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath), Json) ?? new();
        }
        catch { s = new(); }
        s.FillDefaults();
        // Remember the paths found on first run, so the exe keeps working if it's moved or copied elsewhere.
        if (firstRun && File.Exists(Path.Combine(s.ServerDir, "server.js")))
        {
            try { s.Save(); } catch { /* read-only profile: detect again next time */ }
        }
        return s;
    }

    public void Save()
    {
        Directory.CreateDirectory(Folder);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, Json));
    }

    public AppSettings Clone() => JsonSerializer.Deserialize<AppSettings>(JsonSerializer.Serialize(this, Json), Json)!;

    public void FillDefaults()
    {
        if (Port is < 1 or > 65535) Port = 4800;
        if (string.IsNullOrWhiteSpace(NodePath) || !File.Exists(NodePath)) NodePath = FindNode() ?? NodePath;
        if (string.IsNullOrWhiteSpace(ServerDir) || !File.Exists(Path.Combine(ServerDir, "server.js"))) ServerDir = FindServerDir() ?? ServerDir;
        if (!string.IsNullOrWhiteSpace(ServerDir))
        {
            var beside = Path.GetFullPath(Path.Combine(ServerDir, "..", "data"));
            if (string.IsNullOrWhiteSpace(DataDir) || (!Directory.Exists(DataDir) && Directory.Exists(beside))) DataDir = beside;
        }
    }

    public static string? FindNode()
    {
        var exe = OperatingSystem.IsWindows() ? "node.exe" : "node";
        var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries).ToList();
        if (OperatingSystem.IsWindows())
        {
            dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"));
            dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs"));
        }
        else
        {
            dirs.AddRange(new[] { "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin" });
        }
        foreach (var d in dirs)
        {
            try
            {
                var p = Path.Combine(d.Trim('"'), exe);
                if (File.Exists(p)) return p;
            }
            catch { /* bad PATH entry */ }
        }
        return null;
    }

    /// <summary>Walks up from the exe looking for server/server.js (works from bin/Debug and from a publish folder next to the repo).</summary>
    public static string? FindServerDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 10 && dir != null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "server", "server.js");
            if (File.Exists(candidate)) return Path.GetDirectoryName(candidate);
        }
        return null;
    }
}
