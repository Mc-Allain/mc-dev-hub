#if WINDOWS
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace MCDevHub.Platform;

/// <summary>
/// Browser-side network capture for a site window: listens to the page's DevTools network events and sends them
/// to the launcher server (POST /api/net/browser), which keeps them only when that site's launcher is monitored.
/// While the server says "not monitored", nothing is collected; it asks again every few seconds.
/// </summary>
sealed class BrowserCapture : IDisposable
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };
    int MaxBody = 1024 * 1024; // the server can change it (its answer to each batch)
    static readonly HashSet<string> BodyTypes = new(StringComparer.OrdinalIgnoreCase) { "XHR", "Fetch" };

    readonly CoreWebView2 _core;
    readonly List<Dictionary<string, object?>> _queue = new();
    readonly Dictionary<string, Req> _reqs = new();
    readonly Timer _timer = new() { Interval = 400 };
    bool _enabled = true; // optimistic until the server answers
    DateTime _nextProbe = DateTime.MinValue;
    bool _sending, _disposed;
    int _seq;

    sealed class Req
    {
        public string Id = "";
        public double T0;
        public string Type = "";
        public string Mime = "";
        public bool Done;
    }

    public BrowserCapture(CoreWebView2 core)
    {
        _core = core;
        _timer.Tick += async (_, _) => await FlushAsync();
    }

    public async Task StartAsync()
    {
        On("Network.requestWillBeSent", OnRequest);
        On("Network.responseReceived", OnResponse);
        On("Network.loadingFinished", OnFinished);
        On("Network.loadingFailed", OnFailed);
        On("Network.webSocketCreated", p => Start(p.Str("requestId"), new() { ["kind"] = "ws", ["method"] = "GET", ["url"] = p.Str("url"), ["resourceType"] = "WebSocket" }, 0));
        On("Network.webSocketHandshakeResponseReceived", p =>
        {
            if (!_reqs.TryGetValue(p.Str("requestId"), out var r)) return;
            var resp = p.GetProperty("response");
            Add(new() { ["t"] = "update", ["id"] = r.Id, ["status"] = resp.Int("status"), ["statusText"] = resp.Str("statusText"), ["resHeaders"] = Headers(resp, "headers") });
        });
        On("Network.webSocketClosed", p => End(p.Str("requestId"), p.Dbl("timestamp"), new()));
        await _core.CallDevToolsProtocolMethodAsync("Network.enable", "{\"maxPostDataSize\":65536}");
        _timer.Start();
    }

    void On(string evt, Action<JsonElement> handler)
    {
        _core.GetDevToolsProtocolEventReceiver(evt).DevToolsProtocolEventReceived += (_, e) =>
        {
            if (_disposed || !_enabled) return;
            try
            {
                using var doc = JsonDocument.Parse(e.ParameterObjectAsJson);
                handler(doc.RootElement.Clone());
            }
            catch { /* never disturb the page */ }
        };
    }

    // ---------- events ----------
    void OnRequest(JsonElement p)
    {
        var cdpId = p.Str("requestId");
        var req = p.GetProperty("request");
        var url = req.Str("url");
        if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return; // data:, blob:, extensions
        // a redirect reuses the request id: close the previous hop with the redirect's status
        if (p.TryGetProperty("redirectResponse", out var redirect) && _reqs.TryGetValue(cdpId, out var prev) && !prev.Done)
        {
            prev.Done = true;
            Add(new() { ["t"] = "end", ["id"] = prev.Id, ["status"] = redirect.Int("status"), ["statusText"] = redirect.Str("statusText"),
                ["resHeaders"] = Headers(redirect, "headers"), ["duration"] = Ms(p.Dbl("timestamp") - prev.T0) });
        }
        var ev = new Dictionary<string, object?>
        {
            ["kind"] = "http", ["method"] = req.Str("method"), ["url"] = url, ["reqHeaders"] = Headers(req, "headers"),
            ["resourceType"] = p.Str("type"), ["startedAt"] = (long)(p.Dbl("wallTime") * 1000),
        };
        if (req.TryGetProperty("postData", out var post) && post.ValueKind == JsonValueKind.String)
        {
            var text = post.GetString() ?? "";
            ev["reqBody"] = new Dictionary<string, object?> { ["text"] = text.Length > MaxBody ? text[..MaxBody] : text, ["size"] = Encoding.UTF8.GetByteCount(text), ["truncated"] = text.Length > MaxBody };
        }
        Start(cdpId, ev, p.Dbl("timestamp"));
    }

    void Start(string cdpId, Dictionary<string, object?> ev, double ts)
    {
        var r = new Req { Id = $"{cdpId}.{++_seq}", T0 = ts, Type = ev.TryGetValue("resourceType", out var t) ? t as string ?? "" : "" };
        _reqs[cdpId] = r;
        ev["t"] = "start";
        ev["id"] = r.Id;
        if (!ev.ContainsKey("startedAt")) ev["startedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Add(ev);
        if (_reqs.Count > 5000) foreach (var k in _reqs.Where(x => x.Value.Done).Select(x => x.Key).Take(2500).ToList()) _reqs.Remove(k);
    }

    void OnResponse(JsonElement p)
    {
        if (!_reqs.TryGetValue(p.Str("requestId"), out var r)) return;
        var resp = p.GetProperty("response");
        r.Mime = resp.Str("mimeType");
        var ev = new Dictionary<string, object?>
        {
            ["t"] = "update", ["id"] = r.Id, ["status"] = resp.Int("status"), ["statusText"] = resp.Str("statusText"), ["resHeaders"] = Headers(resp, "headers"),
            ["fromCache"] = resp.Bool("fromDiskCache") || resp.Bool("fromServiceWorker") || resp.Bool("fromPrefetchCache"),
        };
        if (!string.IsNullOrEmpty(p.Str("type"))) ev["resourceType"] = p.Str("type");
        Add(ev);
    }

    async void OnFinished(JsonElement p)
    {
        var cdpId = p.Str("requestId");
        if (!_reqs.TryGetValue(cdpId, out var r) || r.Done) return;
        var extra = new Dictionary<string, object?> { ["size"] = (long)p.Dbl("encodedDataLength") };
        if (BodyTypes.Contains(r.Type) && IsText(r.Mime))
        {
            try
            {
                var json = await _core.CallDevToolsProtocolMethodAsync("Network.getResponseBody", JsonSerializer.Serialize(new { requestId = cdpId }));
                using var doc = JsonDocument.Parse(json);
                var body = doc.RootElement.Str("body");
                if (doc.RootElement.Bool("base64Encoded"))
                {
                    try { body = Encoding.UTF8.GetString(Convert.FromBase64String(body)); } catch { body = ""; }
                }
                extra["resBody"] = new Dictionary<string, object?> { ["text"] = body.Length > MaxBody ? body[..MaxBody] : body, ["size"] = Encoding.UTF8.GetByteCount(body), ["truncated"] = body.Length > MaxBody };
            }
            catch { /* body no longer available */ }
        }
        End(cdpId, p.Dbl("timestamp"), extra);
    }

    void OnFailed(JsonElement p)
    {
        var err = p.Str("errorText");
        if (p.Bool("canceled")) err = "Canceled";
        End(p.Str("requestId"), p.Dbl("timestamp"), new() { ["error"] = string.IsNullOrEmpty(err) ? "Failed" : err });
    }

    void End(string cdpId, double ts, Dictionary<string, object?> extra)
    {
        if (!_reqs.TryGetValue(cdpId, out var r) || r.Done) return;
        r.Done = true;
        extra["t"] = "end";
        extra["id"] = r.Id;
        if (r.T0 > 0 && ts > 0) extra["duration"] = Ms(ts - r.T0);
        Add(extra);
    }

    // ---------- sending ----------
    void Add(Dictionary<string, object?> ev)
    {
        _queue.Add(ev);
        if (_queue.Count > 3000) _queue.RemoveRange(0, _queue.Count - 3000);
    }

    async Task FlushAsync()
    {
        if (_sending || _disposed || string.IsNullOrEmpty(WebUiWindow.ServerUrl)) return;
        // while not monitored, only ask now and then whether that changed
        if (!_enabled && DateTime.UtcNow < _nextProbe) return;
        if (_enabled && _queue.Count == 0) return;
        string origin;
        try { origin = new Uri(_core.Source).GetLeftPart(UriPartial.Authority); } catch { return; }
        var batch = _queue.Take(500).ToList();
        _sending = true;
        try
        {
            var payload = JsonSerializer.Serialize(new { origin, events = batch });
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var res = await Http.PostAsync(WebUiWindow.ServerUrl.TrimEnd('/') + "/api/net/browser", content);
            _queue.RemoveRange(0, Math.Min(batch.Count, _queue.Count));
            if (res.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
                var enabled = doc.RootElement.Bool("enabled");
                var max = doc.RootElement.Int("maxBody");
                if (max > 0) MaxBody = max;
                if (!enabled) { _queue.Clear(); _reqs.Clear(); _nextProbe = DateTime.UtcNow.AddSeconds(3); }
                _enabled = enabled;
            }
        }
        catch
        {
            _enabled = false; // server not reachable: pause and ask again later
            _queue.Clear();
            _nextProbe = DateTime.UtcNow.AddSeconds(5);
        }
        finally { _sending = false; }
    }

    // ---------- helpers ----------
    static long Ms(double seconds) => (long)Math.Max(0, Math.Round(seconds * 1000));
    static bool IsText(string mime) =>
        mime.StartsWith("text/", StringComparison.OrdinalIgnoreCase) || mime.Contains("json", StringComparison.OrdinalIgnoreCase) ||
        mime.Contains("xml", StringComparison.OrdinalIgnoreCase) || mime.Contains("javascript", StringComparison.OrdinalIgnoreCase) ||
        mime.Contains("x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase) || mime.Contains("graphql", StringComparison.OrdinalIgnoreCase);
    static Dictionary<string, string> Headers(JsonElement el, string name)
    {
        var d = new Dictionary<string, string>();
        if (!el.TryGetProperty(name, out var h) || h.ValueKind != JsonValueKind.Object) return d;
        foreach (var p in h.EnumerateObject()) d[p.Name.ToLowerInvariant()] = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() ?? "" : p.Value.ToString();
        return d;
    }

    public void Dispose()
    {
        _disposed = true;
        _timer.Stop();
        _timer.Dispose();
    }
}

static class JsonEl
{
    public static string Str(this JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
    public static double Dbl(this JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;
    public static int Int(this JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? (int)v.GetDouble() : 0;
    public static bool Bool(this JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
#endif
