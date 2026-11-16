using System;
using System.Threading;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Platform;
using Avalonia.Styling;
using Avalonia.Threading;
using MCDevHub.Platform;

namespace MCDevHub;

public partial class App : Application
{
    public static App Instance => (App)Current!;
    public AppSettings Settings { get; private set; } = new();
    public ServerHost Server { get; } = new();
    MainWindow? _main;
    TrayIcon? _tray;
    NativeMenuItem? _trayStartStop;
    bool _quitting;

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        Settings = AppSettings.Load();
        ApplyTheme(Settings.Theme);

        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            _main = new MainWindow();
            desktop.ShutdownRequested += async (_, e) =>
            {
                if (_quitting) return;
                e.Cancel = true;
                await QuitAsync();
            };
            CreateTray();
            Server.StateChanged += () => Dispatcher.UIThread.Post(UpdateTray);

            if (!Program.StartMinimized) _main.Show();
            ListenForSecondInstance();

            if (Settings.StartServerOnLaunch)
                _ = StartServerAsync(openUi: Settings.OpenUiOnStart && !Program.StartMinimized);
        }
        base.OnFrameworkInitializationCompleted();
    }

    public void ReplaceSettings(AppSettings s)
    {
        Settings = s;
        Settings.Save();
        ApplyTheme(s.Theme);
        Os.SetStartWithSystem(s.StartWithSystem);
    }

    public void ApplyTheme(string theme) =>
        RequestedThemeVariant = theme switch { "Light" => ThemeVariant.Light, "Dark" => ThemeVariant.Dark, _ => ThemeVariant.Default };

    public async Task StartServerAsync(bool openUi)
    {
        await Server.StartAsync(Settings);
#if WINDOWS
        if (Server.State == ServerState.Running) WebUiWindow.ServerUrl = Server.Url;
#endif
        if (openUi && Server.State == ServerState.Running) OpenUi();
    }

    /// <summary>Stops the server. The web windows (launcher UI and launched sites) close first, since there's nothing left to show.</summary>
    public async Task StopServerAsync()
    {
#if WINDOWS
        await WebUiWindow.CloseAllAsync();
#endif
        await Server.StopAsync();
    }

    /// <summary>Restarts the server: closes the web windows, restarts, then reopens the launcher UI if it was open.</summary>
    public async Task RestartServerAsync()
    {
        bool reopen = false;
#if WINDOWS
        reopen = await WebUiWindow.CloseAllAsync();
#endif
        await Server.StopAsync();
        await Server.StartAsync(Settings);
#if WINDOWS
        if (Server.State == ServerState.Running) WebUiWindow.ServerUrl = Server.Url;
#endif
        if (reopen && Server.State == ServerState.Running) OpenUi();
    }

    /// <summary>Opens the web UI the way the settings say (app window or browser).</summary>
    public void OpenUi(bool forceBrowser = false)
    {
        if (Server.State != ServerState.Running)
        {
            _ = StartServerAsync(openUi: true);
            return;
        }
#if WINDOWS
        if (!forceBrowser && Settings.OpenUiIn == UiMode.AppWindow)
        {
            WebUiWindow.Show(Server.Url, Settings, msg => Dispatcher.UIThread.Post(() => _main?.ShowNotice(msg)));
            return;
        }
#endif
        Os.OpenUrl(Server.Url);
    }

    public void ShowMain()
    {
        if (_main == null) return;
        _main.Show();
        if (_main.WindowState == WindowState.Minimized) _main.WindowState = WindowState.Normal;
        _main.Activate();
    }

    public async Task QuitAsync()
    {
        if (_quitting) return;
        _quitting = true;
        _main?.ShowNotice("Stopping the server and all launchers…");
        await StopServerAsync();
        if (_tray != null) _tray.IsVisible = false;
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime d) d.Shutdown();
    }

    public bool IsQuitting => _quitting;

    void CreateTray()
    {
        var menu = new NativeMenu();
        var open = new NativeMenuItem("Open MC Dev Hub");
        open.Click += (_, _) => OpenUi();
        var browser = new NativeMenuItem("Open in browser");
        browser.Click += (_, _) => OpenUi(forceBrowser: true);
        _trayStartStop = new NativeMenuItem("Stop server");
        _trayStartStop.Click += async (_, _) =>
        {
            if (Server.State == ServerState.Running) await StopServerAsync();
            else await StartServerAsync(openUi: false);
        };
        var settings = new NativeMenuItem("Launcher settings…");
        settings.Click += (_, _) => ShowMain();
        var quit = new NativeMenuItem("Quit");
        quit.Click += async (_, _) => await QuitAsync();
        menu.Add(open);
        menu.Add(browser);
        menu.Add(new NativeMenuItemSeparator());
        menu.Add(_trayStartStop);
        menu.Add(settings);
        menu.Add(new NativeMenuItemSeparator());
        menu.Add(quit);

        _tray = new TrayIcon
        {
            Icon = new WindowIcon(AssetLoader.Open(new Uri("avares://MCDevHub/Assets/icon.ico"))),
            ToolTipText = "MC Dev Hub",
            Menu = menu,
            IsVisible = true,
        };
        _tray.Clicked += (_, _) => OpenUi();
        TrayIcon.SetIcons(this, new TrayIcons { _tray });
        UpdateTray();
    }

    void UpdateTray()
    {
        if (_tray == null || _trayStartStop == null) return;
        var running = Server.State == ServerState.Running;
        _trayStartStop.Header = running ? "Stop server" : "Start server";
        _tray.ToolTipText = running ? $"MC Dev Hub · running on :{Server.Port}" : $"MC Dev Hub · {Server.State.ToString().ToLowerInvariant()}";
    }

    void ListenForSecondInstance()
    {
        var signal = Program.ShowSignal;
        if (signal == null) return;
        var t = new Thread(() =>
        {
            while (true)
            {
                signal.WaitOne();
                Dispatcher.UIThread.Post(ShowMain);
            }
        })
        { IsBackground = true, Name = "SingleInstance" };
        t.Start();
    }
}
