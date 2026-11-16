using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MCDevHub;

public enum ServerState { Stopped, Starting, Running, Stopping, Failed }

/// <summary>Starts, watches and stops the Node server (server/server.js).</summary>
public sealed class ServerHost : IDisposable
{
    readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(3) };
    Process? _proc;
    readonly Timer _watch;
    readonly SemaphoreSlim _gate = new(1, 1);

    public ServerState State { get; private set; } = ServerState.Stopped;
    public bool IsExternal { get; private set; }   // a server we didn't start was already answering on the port
    public int Port { get; private set; }
    public string LastError { get; private set; } = "";

    public event Action? StateChanged;
    public event Action<string>? Log;

    public ServerHost()
    {
        _watch = new Timer(_ => _ = WatchAsync(), null, TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(3));
    }

    public string Url => $"http://localhost:{Port}";

    void Set(ServerState s, string error = "")
    {
        State = s;
        LastError = error;
        StateChanged?.Invoke();
    }

    async Task<bool> HealthyAsync(int port)
    {
        try
        {
            var json = await _http.GetStringAsync($"http://127.0.0.1:{port}/api/health");
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("app", out var app) && app.GetString() == "mc-dev-hub";
        }
        catch { return false; }
    }

    public async Task StartAsync(AppSettings s)
    {
        await _gate.WaitAsync();
        try
        {
            if (State is ServerState.Running or ServerState.Starting) return;
            Port = s.Port;
            IsExternal = false;
            Set(ServerState.Starting);

            if (await HealthyAsync(Port))
            {
                IsExternal = true;
                Log?.Invoke($"An MC Dev Hub server is already running on port {Port}; using it.");
                Set(ServerState.Running);
                return;
            }

            var serverJs = Path.Combine(s.ServerDir, "server.js");
            if (!File.Exists(s.NodePath)) { Fail("Node.js was not found. Set its path in Settings (node.exe)."); return; }
            if (!File.Exists(serverJs)) { Fail($"server.js was not found in \"{s.ServerDir}\". Set the server folder in Settings."); return; }

            var psi = new ProcessStartInfo(s.NodePath)
            {
                WorkingDirectory = s.ServerDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,   // kept open: when this app dies the pipe closes and the server cleans up
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            psi.ArgumentList.Add(serverJs);
            psi.ArgumentList.Add("--port");
            psi.ArgumentList.Add(s.Port.ToString());
            if (!string.IsNullOrWhiteSpace(s.DataDir)) { psi.ArgumentList.Add("--data"); psi.ArgumentList.Add(s.DataDir); }
            psi.Environment["MCDH_WATCH_STDIN"] = "1";

            Log?.Invoke($"> node server.js --port {s.Port}");
            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            p.OutputDataReceived += (_, e) => { if (e.Data != null) Log?.Invoke(e.Data); };
            p.ErrorDataReceived += (_, e) => { if (e.Data != null) Log?.Invoke(e.Data); };
            p.Exited += (_, _) => OnExited(p);
            try { p.Start(); }
            catch (Exception ex) { Fail("Could not start Node.js: " + ex.Message); return; }
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            _proc = p;

            for (int i = 0; i < 40; i++)
            {
                if (p.HasExited) return; // OnExited reports it
                if (await HealthyAsync(Port)) { Set(ServerState.Running); return; }
                await Task.Delay(250);
            }
            Fail("The server did not answer within 10 seconds. Check the log below.");
        }
        finally { _gate.Release(); }
    }

    void Fail(string msg)
    {
        Log?.Invoke("✖ " + msg);
        Set(ServerState.Failed, msg);
    }

    void OnExited(Process p)
    {
        if (_proc != p) return;
        _proc = null;
        int code = 0;
        try { code = p.ExitCode; } catch { }
        if (State == ServerState.Stopping) return;
        Log?.Invoke($"Server exited with code {code}.");
        if (code == 2) Set(ServerState.Failed, $"Port {Port} is already in use by another program. Choose another port.");
        else Set(code == 0 ? ServerState.Stopped : ServerState.Failed, code == 0 ? "" : $"The server stopped unexpectedly (exit code {code}).");
    }

    /// <summary>Asks the server to stop its launchers and exit; kills it if it doesn't.</summary>
    public async Task StopAsync()
    {
        await _gate.WaitAsync();
        try
        {
            if (State is ServerState.Stopped) return;
            var p = _proc;
            Set(ServerState.Stopping);
            Log?.Invoke("Stopping server and its launchers…");
            try
            {
                using var content = new StringContent("{}", Encoding.UTF8, "application/json");
                await _http.PostAsync($"http://127.0.0.1:{Port}/api/shutdown", content);
            }
            catch { /* already gone */ }

            if (p != null)
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(12));
                try { await p.WaitForExitAsync(cts.Token); }
                catch (OperationCanceledException)
                {
                    try { p.Kill(entireProcessTree: true); } catch { }
                }
                _proc = null;
            }
            else
            {
                for (int i = 0; i < 40 && await HealthyAsync(Port); i++) await Task.Delay(250);
            }
            IsExternal = false;
            Log?.Invoke("Server stopped.");
            Set(ServerState.Stopped);
        }
        finally { _gate.Release(); }
    }

    async Task WatchAsync()
    {
        if (State == ServerState.Running && IsExternal && !await HealthyAsync(Port))
        {
            IsExternal = false;
            Log?.Invoke("The external server went away.");
            Set(ServerState.Stopped);
        }
    }

    public void Dispose()
    {
        _watch.Dispose();
        _http.Dispose();
    }
}
