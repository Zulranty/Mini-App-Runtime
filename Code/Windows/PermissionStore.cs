using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

internal sealed class PermissionStore(MiniManifest manifest)
{
    private static string DirectoryPath => Path.Combine(MiniStore.ConfigRoot, "Permissions");
    private static readonly object Sync = new();
    private readonly string path = Path.Combine(DirectoryPath, "by-id",
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(manifest.Id))) + ".json");

    public string StateFor(string permission) => State(permission);

    public string State(string permission)
    {
        lock (Sync) return Read().TryGetValue(permission, out var state) && state is "granted" or "denied"
            ? state : "prompt";
    }

    public void Grant(string permission) => Set(permission, "granted");

    public void Set(string permission, string state)
    {
        if (state is not ("granted" or "denied" or "prompt"))
            throw new ApiError("invalid_params", "Invalid permission state");
        lock (Sync)
        {
            var states = Read();
            if (state == "prompt") states.Remove(permission);
            else states[permission] = state;
            Write(states);
        }
    }

    public void Reset()
    {
        // Retain an empty ID record so old name-keyed grants cannot reappear.
        lock (Sync) Write([]);
    }

    public void EnsureMigrated()
    {
        lock (Sync) _ = Read();
    }

    public void Reconcile(IReadOnlySet<string> next)
    {
        lock (Sync)
        {
            var states = Read();
            var removed = states.Keys.Where(permission => !manifest.Permissions.Contains(permission) || !next.Contains(permission)).ToArray();
            if (removed.Length == 0) return;
            foreach (var permission in removed) states.Remove(permission);
            Write(states);
        }
    }

    private Dictionary<string, string> Read()
    {
        if (File.Exists(path)) return ReadStates(path);

        var legacyNames = LegacyNames(manifest);
        if (!legacyNames.Any(File.Exists)) return [];
        var states = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var legacy in legacyNames)
        {
            foreach (var (permission, state) in ReadStates(legacy))
            {
                if (!manifest.Permissions.Contains(permission)) continue;
                // Legacy files identify a display name only. Retain denials and request fresh grants.
                if (state == "denied") states[permission] = state;
            }
        }
        Write(states);
        return states;
    }

    private static string[] LegacyNames(MiniManifest app) => app.Locales.Values
        .Select(locale => locale.Name).OfType<string>().Append(app.Name)
        .Select(name => Path.Combine(DirectoryPath, LegacyFileName(name)))
        .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

    private static string LegacyFileName(string appName)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var name = string.Concat(appName.Trim().Select(ch => invalid.Contains(ch) || char.IsControl(ch) ? '_' : ch)).TrimEnd('.', ' ');
        return (string.IsNullOrWhiteSpace(name) ? "MiniApp" : name) + ".json";
    }

    private static Dictionary<string, string> ReadStates(string file)
    {
        try
        {
            return JsonNode.Parse(File.ReadAllText(file)) switch
            {
                JsonArray legacy => legacy.OfType<JsonValue>()
                    .Select(value => value.TryGetValue<string>(out var entry) ? entry : null)
                    .OfType<string>().Distinct().ToDictionary(permission => permission, _ => "granted"),
                JsonObject states => states.Deserialize<Dictionary<string, string>>() ?? [],
                _ => []
            };
        }
        catch (FileNotFoundException) { return []; }
        catch (JsonException) { return []; }
    }

    private void Write(Dictionary<string, string> states)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(states));
            File.Move(temporary, path, overwrite: true);
        }
        finally { File.Delete(temporary); }
    }
}
