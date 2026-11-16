#if WINDOWS
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MCDevHub.Platform;

/// <summary>
/// WebView2 windows: the launcher UI itself, plus a window per site opened from it ("Open" on a launcher).
/// All of them live on one dedicated STA thread with its own WinForms message loop (independent of Avalonia)
/// and share one WebView2 profile, so logins/cookies in your sites survive between windows and restarts.
/// </summary>
public static class WebUiWindow
{
    static SynchronizationContext? _ui;
    static readonly object Lock = new();
    static UiForm? _launcher;
    static readonly Dictionary<string, SiteForm> Sites = new(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, UiForm> Tools = new(StringComparer.OrdinalIgnoreCase);
    static Task<CoreWebView2Environment>? _env;
    internal static AppSettings Settings = new();
    /// <summary>The launcher server's address, for site windows that report network traffic to it.</summary>
    public static string ServerUrl { get; set; } = "";
    internal static Action<string> OnError = _ => { };

    public static bool IsOpen => _launcher is { IsDisposed: false };

    /// <summary>Runs an action on the WebView thread, starting the thread the first time.</summary>
    static void OnUi(Action action)
    {
        lock (Lock)
        {
            if (_ui == null)
            {
                using var ready = new ManualResetEventSlim();
                var t = new Thread(() =>
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
                    _ui = SynchronizationContext.Current;
                    ready.Set();
                    Application.Run(); // runs for the life of the app; windows come and go
                })
                { IsBackground = true, Name = "WebView" };
                t.SetApartmentState(ApartmentState.STA);
                t.Start();
                ready.Wait();
            }
        }
        _ui!.Post(_ => { try { action(); } catch (Exception ex) { OnError("Window error: " + ex.Message); } }, null);
    }

    internal static Task<CoreWebView2Environment> Env()
    {
        // must be created on the WebView thread; every window reuses it (one browser profile)
        if (_env == null)
        {
            var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MCDevHub", "WebView2");
            _env = CoreWebView2Environment.CreateAsync(null, dataDir);
        }
        return _env;
    }

    /// <summary>Shows the launcher UI window.</summary>
    public static void Show(string url, AppSettings settings, Action<string> onError)
    {
        Settings = settings;
        OnError = onError;
        try { ServerUrl = new Uri(url).GetLeftPart(UriPartial.Authority); } catch { }
        OnUi(() =>
        {
            if (_launcher is { IsDisposed: false } f) { f.BringToFrontAndGo(url); return; }
            _launcher = new UiForm(url, "MC Dev Hub", main: true);
            _launcher.FormClosed += (_, _) => _launcher = null;
            _launcher.Show();
        });
    }

    /// <summary>Opens (or focuses) a site in its own window. One window per site origin.</summary>
    public static void OpenSite(string url, string title)
    {
        OnUi(() =>
        {
            string key;
            try { key = new Uri(url).GetLeftPart(UriPartial.Authority); } catch { key = url; }
            if (Sites.TryGetValue(key, out var existing) && !existing.IsDisposed)
            {
                existing.BringToFrontAndGo(url);
                return;
            }
            var site = new SiteForm(url, title);
            Sites[key] = site;
            site.FormClosed += (_, _) => { if (Sites.TryGetValue(key, out var s) && s == site) Sites.Remove(key); };
            site.Show();
        });
    }

    /// <summary>Opens (or focuses) another page of the launcher UI in its own window, e.g. Running instances.</summary>
    static void OpenTool(string url, string title)
    {
        OnUi(() =>
        {
            if (Tools.TryGetValue(url, out var existing) && !existing.IsDisposed) { existing.BringToFrontAndGo(url); return; }
            var form = new UiForm(url, title, main: false);
            Tools[url] = form;
            form.FormClosed += (_, _) => { if (Tools.TryGetValue(url, out var f) && f == form) Tools.Remove(url); };
            form.Show();
        });
    }

    /// <summary>Opens a pop-up window a site asked for (window.open / target=_blank), keeping window.opener.</summary>
    internal static SiteForm OpenPopup(string url, CoreWebView2NewWindowRequestedEventArgs e)
    {
        var deferral = e.GetDeferral();
        var site = new SiteForm(url, "", popup: e, popupDeferral: deferral);
        site.Show();
        return site;
    }

    public static void Close() => _ = CloseAllAsync();

    /// <summary>
    /// Closes the launcher window and every site window, and completes once they're gone.
    /// Returns whether the launcher window was open (so a restart can bring it back).
    /// </summary>
    public static Task<bool> CloseAllAsync()
    {
        if (_ui == null) return Task.FromResult(false);
        var done = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        OnUi(() =>
        {
            bool wasOpen = _launcher is { IsDisposed: false };
            foreach (Form f in new List<Form>(Application.OpenForms.Cast<Form>())) f.Close();
            done.TrySetResult(wasOpen);
        });
        return done.Task;
    }

    // ---------------------------------------------------------------------------------------------

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    internal static bool Dark => Settings.Theme == "Dark" || (Settings.Theme != "Light" && Os.SystemIsDark());

    internal static void ApplyTitleBar(Form form, bool dark)
    {
        void Apply()
        {
            int v = dark ? 1 : 0;
            DwmSetWindowAttribute(form.Handle, 20, ref v, sizeof(int)); // DWMWA_USE_IMMERSIVE_DARK_MODE
        }
        if (form.IsHandleCreated) Apply(); else form.HandleCreated += (_, _) => Apply();
    }

    internal static Icon? AppIcon()
    {
        try { return Icon.ExtractAssociatedIcon(Environment.ProcessPath!); } catch { return null; }
    }

    // ---------------------------------------------------------------------------------------------
    /// <summary>The launcher UI (main = the main window; otherwise another launcher page such as Running instances).</summary>
    sealed class UiForm : Form
    {
        readonly WebView2 _web = new() { Dock = DockStyle.Fill };
        string _url;
        readonly string _origin, _title;
        readonly bool _main;

        public UiForm(string url, string title, bool main)
        {
            _url = url;
            _main = main;
            _title = title;
            try { _origin = new Uri(url).GetLeftPart(UriPartial.Authority); } catch { _origin = url; }
            Text = title;
            StartPosition = FormStartPosition.CenterScreen;
            if (main)
            {
                MinimumSize = new Size(760, 520);
                Size = new Size(Math.Max(760, Settings.UiWidth), Math.Max(520, Settings.UiHeight));
                if (Settings.UiMaximized) WindowState = FormWindowState.Maximized;
            }
            else
            {
                MinimumSize = new Size(520, 360);
                Size = new Size(1000, 720);
            }
            Icon = AppIcon();
            var dark = Dark;
            BackColor = dark ? Color.FromArgb(17, 21, 28) : Color.FromArgb(246, 247, 249);
            _web.DefaultBackgroundColor = BackColor;
            Controls.Add(_web);
            ApplyTitleBar(this, dark);
            Load += async (_, _) => await InitAsync();
            FormClosing += (_, _) =>
            {
                if (!_main) return;
                Settings.UiMaximized = WindowState == FormWindowState.Maximized;
                if (WindowState == FormWindowState.Normal) { Settings.UiWidth = Width; Settings.UiHeight = Height; }
                try { Settings.Save(); } catch { }
            };
        }

        async Task InitAsync()
        {
            try
            {
                await _web.EnsureCoreWebView2Async(await Env());
                var core = _web.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false;
                core.NewWindowRequested += (_, e) => { e.Handled = true; Os.OpenUrl(e.Uri); }; // GitHub links etc.
                core.WebMessageReceived += OnMessage;
                core.DocumentTitleChanged += (_, _) => Text = string.IsNullOrWhiteSpace(core.DocumentTitle) ? _title : core.DocumentTitle;
                core.NavigationStarting += (_, e) =>
                {
                    if (!e.Uri.StartsWith(_origin, StringComparison.OrdinalIgnoreCase) && e.Uri.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                    {
                        e.Cancel = true;
                        Os.OpenUrl(e.Uri);
                    }
                };
                core.Navigate(_url);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                OnError("The Microsoft Edge WebView2 Runtime is not installed, so the UI was opened in your browser instead. Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                Os.OpenUrl(_url);
                Close();
            }
            catch (Exception ex)
            {
                OnError("Could not open the app window: " + ex.Message + ". Opened the browser instead.");
                Os.OpenUrl(_url);
                Close();
            }
        }

        public void BringToFrontAndGo(string url)
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            if (!string.Equals(url, _url, StringComparison.OrdinalIgnoreCase) && _web.CoreWebView2 != null)
            {
                _url = url;
                _web.CoreWebView2.Navigate(url);
            }
        }

        void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                using var doc = JsonDocument.Parse(e.WebMessageAsJson);
                var root = doc.RootElement;
                var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
                switch (type)
                {
                    case "pickFolder":
                    {
                        var id = root.GetProperty("id").GetInt32();
                        var initial = root.TryGetProperty("initial", out var i) ? i.GetString() : null;
                        using var dlg = new FolderBrowserDialog { ShowNewFolderButton = true, UseDescriptionForTitle = true, Description = "Select a folder" };
                        if (!string.IsNullOrWhiteSpace(initial))
                        {
                            var full = initial.Replace('/', Path.DirectorySeparatorChar);
                            if (Directory.Exists(full)) dlg.InitialDirectory = Path.GetFullPath(full);
                        }
                        var result = dlg.ShowDialog(this) == DialogResult.OK ? dlg.SelectedPath : null;
                        _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, result }));
                        break;
                    }
                    case "openSite":
                    {
                        var url = root.GetProperty("url").GetString();
                        var title = root.TryGetProperty("title", out var tt) ? tt.GetString() ?? "" : "";
                        if (!string.IsNullOrEmpty(url) && url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) OpenSite(url, title);
                        break;
                    }
                    case "openWindow":
                    {
                        // only pages of the launcher itself
                        var path = root.TryGetProperty("path", out var pp) ? pp.GetString() ?? "" : "";
                        var title = root.TryGetProperty("title", out var tt) ? tt.GetString() ?? "" : "";
                        if (path.StartsWith("/") && !path.StartsWith("//")) OpenTool(_origin + path, title == "" ? "MC Dev Hub" : title);
                        break;
                    }
                    case "theme":
                    {
                        var theme = root.GetProperty("theme").GetString();
                        ApplyTitleBar(this, theme == "dark" || (theme != "light" && Os.SystemIsDark()));
                        break;
                    }
                }
            }
            catch { /* malformed message */ }
        }
    }
}

/// <summary>
/// A launched site in its own window, made to look like an app: no address bar or buttons, just the page.
/// Browser keys still work (Alt+Left/Right, F5, F12 for DevTools); the right-click menu keeps only editing items.
/// </summary>
sealed class SiteForm : Form
{
    readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    readonly string _label;
    readonly string _url;
    readonly CoreWebView2NewWindowRequestedEventArgs? _popup;
    readonly CoreWebView2Deferral? _popupDeferral;
    BrowserCapture? _capture;

    // browser entries removed from the right-click menu (back/forward/reload are re-added as our own, in every context)
    static readonly HashSet<string> BrowserMenuItems = new(StringComparer.OrdinalIgnoreCase)
    {
        "back", "forward", "reload", "saveAs", "print", "createQrCode", "share", "webCapture", "sendTabToSelf",
        "openLinkInNewWindow", "saveLinkAs", "saveImageAs", "openImageInNewWindow", "saveMediaAs", "openMediaInNewWindow", "other",
    };

    public SiteForm(string url, string label, CoreWebView2NewWindowRequestedEventArgs? popup = null, CoreWebView2Deferral? popupDeferral = null)
    {
        _url = url;
        _label = label;
        _popup = popup;
        _popupDeferral = popupDeferral;
        Text = string.IsNullOrEmpty(label) ? url : label;
        Icon = WebUiWindow.AppIcon();
        StartPosition = FormStartPosition.WindowsDefaultLocation;
        Size = new Size(1280, 860);
        MinimumSize = new Size(480, 360);

        bool dark = WebUiWindow.Dark;
        BackColor = dark ? Color.FromArgb(17, 21, 28) : Color.FromArgb(246, 247, 249);
        _web.DefaultBackgroundColor = Color.White;
        Controls.Add(_web);
        WebUiWindow.ApplyTitleBar(this, dark);
        Load += async (_, _) => await InitAsync();
        FormClosed += (_, _) => _capture?.Dispose();
    }

    async Task InitAsync()
    {
        try
        {
            await _web.EnsureCoreWebView2Async(await WebUiWindow.Env());
            var core = _web.CoreWebView2;
            // browser-side network capture (kept by the server only for launchers with the monitor on)
            try { _capture = new BrowserCapture(core); await _capture.StartAsync(); } catch { _capture = null; }
            core.Settings.IsStatusBarEnabled = false; // no link preview in the corner
            core.Settings.AreDevToolsEnabled = true; // F12 still opens them
            core.DocumentTitleChanged += (_, _) =>
            {
                var t = core.DocumentTitle;
                // the page's own title, like an app; fall back to the launcher name (titles that are just a URL don't count)
                Text = !string.IsNullOrWhiteSpace(t) && !t.Contains("://") && !t.StartsWith("localhost", StringComparison.OrdinalIgnoreCase)
                    ? t : (_label != "" ? _label : t);
            };
            core.ContextMenuRequested += (_, e) =>
            {
                var items = e.MenuItems;
                for (int i = items.Count - 1; i >= 0; i--)
                    if (BrowserMenuItems.Contains(items[i].Name)) items.RemoveAt(i);

                // the window has no toolbar, so its tools live here: Back / Forward / Reload at the top …
                var env = core.Environment;
                CoreWebView2ContextMenuItem Item(string label, bool enabled, Action run)
                {
                    var item = env.CreateContextMenuItem(label, null, CoreWebView2ContextMenuItemKind.Command);
                    item.IsEnabled = enabled;
                    item.CustomItemSelected += (_, _) => { try { run(); } catch { } };
                    return item;
                }
                CoreWebView2ContextMenuItem Sep() => env.CreateContextMenuItem("", null, CoreWebView2ContextMenuItemKind.Separator);
                var top = new[]
                {
                    Item("Back", core.CanGoBack, () => core.GoBack()),
                    Item("Forward", core.CanGoForward, () => core.GoForward()),
                    Item("Reload", true, () => core.Reload()),
                    Item("Hard reload (ignore cache)", true, () => _ = core.CallDevToolsProtocolMethodAsync("Page.reload", "{\"ignoreCache\":true}")),
                    Sep(),
                };
                for (int i = 0; i < top.Length; i++) items.Insert(i, top[i]);

                // … and the window's own tools at the bottom, above Inspect
                var page = core.Source;
                var bottom = new[]
                {
                    Sep(),
                    Item("Open in browser", true, () => Os.OpenUrl(page)),
                    Item("Copy page address", true, () => Clipboard.SetText(page)),
                    Item("Zoom in", true, () => _web.ZoomFactor = Math.Min(3, _web.ZoomFactor + 0.1)),
                    Item("Zoom out", true, () => _web.ZoomFactor = Math.Max(0.3, _web.ZoomFactor - 0.1)),
                    Item("Reset zoom", Math.Abs(_web.ZoomFactor - 1) > 0.01, () => _web.ZoomFactor = 1),
                };
                int at = items.Count;
                for (int i = 0; i < items.Count; i++) if (string.Equals(items[i].Name, "inspectElement", StringComparison.OrdinalIgnoreCase)) { at = i; break; }
                foreach (var b in bottom) items.Insert(at++, b);
                if (at < items.Count) items.Insert(at, Sep()); // separator before Inspect
                else items.Add(Item("Developer tools", true, () => core.OpenDevToolsWindow()));

                // tidy separators left at the ends or doubled up
                for (int i = items.Count - 1; i >= 0; i--)
                {
                    bool sep = items[i].Kind == CoreWebView2ContextMenuItemKind.Separator;
                    if (sep && (i == 0 || i == items.Count - 1 || items[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator)) items.RemoveAt(i);
                }
                if (items.Count == 0) e.Handled = true;
            };
            core.NewWindowRequested += (_, e) =>
            {
                // pop-ups and target=_blank open in another app window, keeping window.opener (OAuth etc.)
                WebUiWindow.OpenPopup(e.Uri, e);
            };
            core.WindowCloseRequested += (_, _) => Close();
            if (_popup != null)
            {
                _popup.NewWindow = core;
                _popup.Handled = true;
                _popupDeferral?.Complete();
            }
            else core.Navigate(_url);
        }
        catch (Exception ex)
        {
            _popupDeferral?.Complete();
            WebUiWindow.OnError("Could not open the site window (" + ex.Message + "). Opened it in your browser instead.");
            Os.OpenUrl(_url);
            Close();
        }
    }

    public void BringToFrontAndGo(string url)
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        var current = _web.Source?.ToString() ?? "";
        // already on that site: just bring it forward unless a different page was asked for
        if (_web.CoreWebView2 != null && !current.StartsWith(url.TrimEnd('/'), StringComparison.OrdinalIgnoreCase)) _web.CoreWebView2.Navigate(url);
    }
}
#endif
