using System.Collections.Generic;
using System.Linq;

using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace ROMLab.BizHawk
{
    /// <summary>
    /// Wire format for the ROMLab bridge protocol. The shapes here must stay in
    /// step with <c>packages/schema/src/protocol.ts</c>; the TypeScript side is
    /// the specification and this is the implementation of it.
    /// </summary>
    public sealed class BridgeRequest
    {
        public int Id { get; set; }
        public string Op { get; set; } = "status";
        public int Frames { get; set; }
        public int Port { get; set; }
        public IReadOnlyList<string> Buttons { get; set; } = new List<string>();
        public string Domain { get; set; } = string.Empty;
        public long Start { get; set; }
        public int Length { get; set; }
        public string Label { get; set; } = string.Empty;
    }

    public sealed class EmulatorStatus
    {
        public string Emulator { get; set; } = string.Empty;
        public string EmulatorVersion { get; set; } = string.Empty;
        public string Core { get; set; } = string.Empty;
        public string? CoreVersion { get; set; }
        public string RomSha256 { get; set; } = string.Empty;
        /// <summary>Diagnostics only — BizHawk's database identity, not ROMLab's.</summary>
        public string? GameName { get; set; }
        public string? GameHash { get; set; }
        public int Frame { get; set; }
        public bool Paused { get; set; }
    }

    internal static class Json
    {
        public static BridgeRequest ParseRequest(string line)
        {
            var root = JObject.Parse(line);
            var command = (JObject?)root["command"] ?? new JObject();

            return new BridgeRequest
            {
                Id = root.Value<int?>("id") ?? 0,
                Op = command.Value<string>("op") ?? "status",
                Frames = command.Value<int?>("frames") ?? 0,
                Port = command.Value<int?>("port") ?? 0,
                Buttons = command["buttons"]?.Values<string>().Where(b => b != null).Select(b => b!).ToList()
                          ?? new List<string>(),
                Domain = command.Value<string>("domain") ?? string.Empty,
                Start = command.Value<long?>("start") ?? 0,
                Length = command.Value<int?>("length") ?? 0,
                Label = command.Value<string>("label") ?? string.Empty,
            };
        }

        public static string Ok(int id, int frame) =>
            Serialize(new { id, ok = true, frame, result = new { kind = "none" } });

        public static string Error(int id, string code, string message) =>
            Serialize(new { id, ok = false, error = new { code, message } });

        public static string Status(int id, int frame, EmulatorStatus status) =>
            Serialize(new
            {
                id,
                ok = true,
                frame,
                result = new
                {
                    kind = "status",
                    status = new
                    {
                        emulator = status.Emulator,
                        emulatorVersion = status.EmulatorVersion,
                        core = status.Core,
                        coreVersion = status.CoreVersion,
                        romSha256 = status.RomSha256,
                        gameName = status.GameName,
                        gameHash = status.GameHash,
                        frame = status.Frame,
                        paused = status.Paused,
                    },
                },
            });

        public static string Domain(int id, int frame, string domain, long start, string base64) =>
            Serialize(new { id, ok = true, frame, result = new { kind = "domain", domain, start, base64 } });

        public static string Screenshot(int id, int frame, int width, int height, string base64) =>
            Serialize(new { id, ok = true, frame, result = new { kind = "screenshot", width, height, base64 } });

        public static string Savestate(int id, int frame, string label, string sha256) =>
            Serialize(new { id, ok = true, frame, result = new { kind = "savestate", label, sha256 } });

        private static string Serialize(object value) =>
            JsonConvert.SerializeObject(value, new JsonSerializerSettings
            {
                NullValueHandling = NullValueHandling.Ignore,
            });
    }
}
