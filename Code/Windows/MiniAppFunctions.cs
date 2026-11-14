using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

internal sealed class MiniAppFunctions : IDisposable
{
    public Dictionary<string, Func<JsonObject, ValueTask<JsonNode?>>> Handlers { get; } = new(StringComparer.Ordinal);
    public bool EnableStreams { get; set; }
    public bool AllowExternalDrop { get; set; }
    public NativeTopBar? TopBar { get; set; }
    public Action? BeforeLogWrite { get; set; }
    public IDisposable? Lifetime { private get; set; }

    public void Register(string method, Func<JsonObject, JsonNode?> handler) =>
        Handlers.Add(method, parameters => new ValueTask<JsonNode?>(handler(parameters)));

    public void Dispose() => Lifetime?.Dispose();
}
