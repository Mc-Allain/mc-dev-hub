using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using MCDevHub.Platform;

namespace MCDevHub;

public partial class MainWindow : Window
{
    readonly LinkedList<string> _log = new();
    const int MaxLogLines = 400;
    static App A => App.Instance;

    public MainWindow()
    {
        InitializeComponent();
        LoadForm(A.Settings);
        A.Server.StateChanged += () => Dispatcher.UIThread.Post(UpdateState);
        A.Server.Log += line => Dispatcher.UIThread.Post(() => AppendLog(line));
        UpdateState();
        if (!OperatingSystem.IsWindows())
        {
            StartWithSystemBox.Content = "Start at login (in the menu bar)";
            ModeWindow.IsEnabled = false; // native web view not wired up yet on macOS
        }
        Closing += OnClosing;
    }

    void OnClosing(object? sender, WindowClosingEventArgs e)
    {
        if (A.IsQuitting) return;
        if (A.Settings.CloseToTray)
        {
            e.Cancel = true;
            Hide();
        }
        else
        {
            e.Cancel = true;
            _ = A.QuitAsync();
        }
    }

    // ---------- form ----------
    void LoadForm(AppSettings s)
    {
        PortBox.Value = s.Port;
        ModeWindow.IsChecked = s.OpenUiIn == UiMode.AppWindow && OperatingSystem.IsWindows();
        ModeBrowser.IsChecked = !ModeWindow.IsChecked;
        ThemeBox.SelectedIndex = s.Theme switch { "Light" => 1, "Dark" => 2, _ => 0 };
        StartServerBox.IsChecked = s.StartServerOnLaunch;
        OpenUiBox.IsChecked = s.OpenUiOnStart;
        StartWithSystemBox.IsChecked = s.StartWithSystem;
        CloseToTrayBox.IsChecked = s.CloseToTray;
        NodeBox.Text = s.NodePath;
        ServerBox.Text = s.ServerDir;
        DataBox.Text = s.DataDir;
        SaveHint.Text = "";
    }

    AppSettings ReadForm()
    {
        var s = A.Settings.Clone();
        s.Port = (int)(PortBox.Value ?? 4800);
        s.OpenUiIn = ModeWindow.IsChecked == true ? UiMode.AppWindow : UiMode.Browser;
        s.Theme = ThemeBox.SelectedIndex switch { 1 => "Light", 2 => "Dark", _ => "System" };
        s.StartServerOnLaunch = StartServerBox.IsChecked == true;
        s.OpenUiOnStart = OpenUiBox.IsChecked == true;
        s.StartWithSystem = StartWithSystemBox.IsChecked == true;
        s.CloseToTray = CloseToTrayBox.IsChecked == true;
        s.NodePath = (NodeBox.Text ?? "").Trim().Trim('"');
        s.ServerDir = (ServerBox.Text ?? "").Trim().Trim('"');
        s.DataDir = (DataBox.Text ?? "").Trim().Trim('"');
        return s;
    }

    async void SaveClick(object? sender, RoutedEventArgs e)
    {
        var next = ReadForm();
        if (!File.Exists(next.NodePath)) { ShowNotice("Node.js was not found at that path. Pick node.exe or leave it empty to auto-detect."); return; }
        if (!File.Exists(Path.Combine(next.ServerDir, "server.js"))) { ShowNotice("That server folder has no server.js. It should be the \"server\" folder of this project."); return; }

        var prev = A.Settings;
        bool needsRestart = prev.Port != next.Port || prev.NodePath != next.NodePath || prev.ServerDir != next.ServerDir || prev.DataDir != next.DataDir;
        A.ReplaceSettings(next);
        DismissNotice(null, null!);
        if (needsRestart && A.Server.State == ServerState.Running)
        {
            if (A.Server.IsExternal)
            {
                SaveHint.Text = "Saved. The running server was started elsewhere; stop it and start again to use the new settings.";
            }
            else
            {
                SaveHint.Text = "Saved. Restarting the server…";
                await A.RestartServerAsync();
                SaveHint.Text = "Saved and restarted. Your launchers were stopped by the restart.";
            }
        }
        else SaveHint.Text = "Saved.";
        UpdateState();
    }

    void RevertClick(object? sender, RoutedEventArgs e) => LoadForm(A.Settings);

    // ---------- buttons ----------
    void OpenUiClick(object? sender, RoutedEventArgs e) => A.OpenUi();
    void BrowserClick(object? sender, RoutedEventArgs e) => A.OpenUi(forceBrowser: true);
    async void QuitClick(object? sender, RoutedEventArgs e) => await A.QuitAsync();

    async void StartStopClick(object? sender, RoutedEventArgs e)
    {
        if (A.Server.State is ServerState.Running or ServerState.Starting)
        {
            if (!await ConfirmStopAsync(restart: false)) return;
            await A.StopServerAsync();
        }
        else
        {
            DismissNotice(null, null!);
            await A.StartServerAsync(openUi: false);
        }
    }

    async void RestartClick(object? sender, RoutedEventArgs e)
    {
        if (A.Server.State == ServerState.Running && !await ConfirmStopAsync(restart: true)) return;
        DismissNotice(null, null!);
        await A.RestartServerAsync();
    }

    Task<bool> ConfirmStopAsync(bool restart)
    {
        // Stopping the server stops every running launcher; a quick inline confirmation keeps that from being a surprise.
        var tcs = new TaskCompletionSource<bool>();
        var dlg = new Window
        {
            Title = restart ? "Restart the server?" : "Stop the server?",
            Width = 400, SizeToContent = SizeToContent.Height, CanResize = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner, ShowInTaskbar = false,
        };
        var yes = new Button { Content = restart ? "Restart" : "Stop", Classes = { "accent" } };
        var no = new Button { Content = "Cancel", Classes = { "ghost" } };
        yes.Click += (_, _) => { tcs.TrySetResult(true); dlg.Close(); };
        no.Click += (_, _) => { tcs.TrySetResult(false); dlg.Close(); };
        dlg.Closed += (_, _) => tcs.TrySetResult(false);
        dlg.Content = new StackPanel
        {
            Margin = new Avalonia.Thickness(18), Spacing = 14,
            Children =
            {
                new TextBlock { Text = restart
                    ? "All running launchers (your dev servers) will be stopped. The MC Dev Hub window closes and reopens once the server is back; site windows close."
                    : "All running launchers (your dev servers) will be stopped, and the MC Dev Hub and site windows will close.", TextWrapping = TextWrapping.Wrap },
                new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 8, HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right, Children = { no, yes } },
            },
        };
        dlg.ShowDialog(this);
        return tcs.Task;
    }

    async void BrowseNode(object? sender, RoutedEventArgs e)
    {
        var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Select node executable",
            AllowMultiple = false,
            FileTypeFilter = OperatingSystem.IsWindows() ? new[] { new FilePickerFileType("node.exe") { Patterns = new[] { "node.exe" } } } : null,
        });
        var p = files.FirstOrDefault()?.TryGetLocalPath();
        if (p != null) NodeBox.Text = p;
    }

    async Task<string?> PickFolder(string title, string? start)
    {
        var opts = new FolderPickerOpenOptions { Title = title, AllowMultiple = false };
        if (!string.IsNullOrWhiteSpace(start) && Directory.Exists(start))
            opts.SuggestedStartLocation = await StorageProvider.TryGetFolderFromPathAsync(start);
        var res = await StorageProvider.OpenFolderPickerAsync(opts);
        return res.FirstOrDefault()?.TryGetLocalPath();
    }

    async void BrowseServer(object? sender, RoutedEventArgs e)
    {
        var p = await PickFolder("Select the server folder (contains server.js)", ServerBox.Text);
        if (p != null) ServerBox.Text = p;
    }

    async void BrowseData(object? sender, RoutedEventArgs e)
    {
        var p = await PickFolder("Select the data folder", DataBox.Text);
        if (p != null) DataBox.Text = p;
    }

    void OpenData(object? sender, RoutedEventArgs e)
    {
        if (!string.IsNullOrWhiteSpace(DataBox.Text)) Os.OpenFolder(DataBox.Text);
    }

    // ---------- state + log ----------
    void UpdateState()
    {
        var srv = A.Server;
        var port = srv.State == ServerState.Stopped ? A.Settings.Port : srv.Port;
        UrlText.Text = $"http://localhost:{port}";
        string text; string brush;
        switch (srv.State)
        {
            case ServerState.Running: text = srv.IsExternal ? $"Running on :{srv.Port} (started elsewhere)" : $"Running on :{srv.Port}"; brush = "Ok"; break;
            case ServerState.Starting: text = "Starting…"; brush = "Warn"; break;
            case ServerState.Stopping: text = "Stopping…"; brush = "Warn"; break;
            case ServerState.Failed: text = "Not running"; brush = "Danger"; break;
            default: text = "Stopped"; brush = "Line"; break;
        }
        StatusText.Text = text;
        if (this.TryFindResource(brush, ActualThemeVariant, out var b) && b is IBrush br) StatusDot.Fill = br;

        bool running = srv.State == ServerState.Running;
        bool busy = srv.State is ServerState.Starting or ServerState.Stopping;
        StartStopButton.Content = running || srv.State == ServerState.Starting ? "■ Stop server" : "▶ Start server";
        StartStopButton.Classes.Set("go", !(running || srv.State == ServerState.Starting));
        StartStopButton.Classes.Set("ghost", running || srv.State == ServerState.Starting);
        StartStopButton.IsEnabled = !busy;
        RestartButton.IsEnabled = !busy;
        OpenUiButton.Content = running ? "Open MC Dev Hub" : "Start & open";
        OpenUiButton.IsEnabled = !busy;
        BrowserButton.IsEnabled = running;
        if (srv.State == ServerState.Failed && !string.IsNullOrEmpty(srv.LastError)) ShowNotice(srv.LastError);
    }

    void AppendLog(string line)
    {
        _log.AddLast(line);
        while (_log.Count > MaxLogLines) _log.RemoveFirst();
        LogText.Text = string.Join(Environment.NewLine, _log);
        LogScroll.ScrollToEnd();
    }

    void ClearLog(object? sender, RoutedEventArgs e)
    {
        _log.Clear();
        LogText.Text = "";
    }

    public void ShowNotice(string msg)
    {
        NoticeText.Text = msg;
        NoticeBox.IsVisible = true;
    }

    void DismissNotice(object? sender, RoutedEventArgs e) => NoticeBox.IsVisible = false;
}
