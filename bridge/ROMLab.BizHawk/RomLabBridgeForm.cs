using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

using BizHawk.Client.Common;
using BizHawk.Client.EmuHawk;
using BizHawk.Common;
using BizHawk.Emulation.Common;

namespace ROMLab.BizHawk
{
    /// <summary>
    /// ROMLab bridge: a BizHawk external tool that exposes deterministic frame
    /// control and synchronised state capture over the ROMLab bridge protocol
    /// (newline-delimited JSON over TCP).
    ///
    /// Two rules shape this file.
    ///
    /// First, every ApiHawk call must run on the emulator thread. The TCP
    /// listener therefore never touches the emulator directly: it enqueues a
    /// work item and blocks until <see cref="UpdateAfter"/> — which BizHawk
    /// calls on the emulator thread — has executed it. Calling the API from the
    /// socket thread appears to work and then corrupts state under load.
    ///
    /// Second, ROMLab does not drive BizHawk with synthesised keystrokes.
    /// Input is injected through the joypad API so that a command log replays
    /// to the same frames on another machine.
    /// </summary>
    [ExternalTool("ROMLab Bridge", Description = "Deterministic capture bridge for ROMLab AI")]
    public sealed class RomLabBridgeForm : ToolFormBase, IExternalToolForm
    {
        public const string ProtocolVersion = "romlab.bridge.v1";
        private const int DefaultPort = 51735;

        public ApiContainer? _apiContainer { get; set; }
        private ApiContainer Apis => _apiContainer ?? throw new InvalidOperationException("ApiHawk container not injected.");

        protected override string WindowTitleStatic => "ROMLab Bridge";

        private readonly BlockingCollection<WorkItem> _queue = new BlockingCollection<WorkItem>();
        private readonly CancellationTokenSource _shutdown = new CancellationTokenSource();
        private TcpListener? _listener;
        private Thread? _listenerThread;
        private string _romSha256 = string.Empty;
        private readonly Label _statusLabel = new Label { AutoSize = true, Left = 8, Top = 8 };

        public RomLabBridgeForm()
        {
            ClientSize = new System.Drawing.Size(360, 60);
            Controls.Add(_statusLabel);
        }

        public override void Restart()
        {
            // Restart fires whenever a core or ROM is loaded. The ROM identity is
            // captured here so every response can be attributed to one cartridge.
            _romSha256 = ComputeRomSha256();
            StartListener();
            _statusLabel.Text = $"Listening on port {Port}\nROM {Shorten(_romSha256)}";
        }

        private static int Port
        {
            get
            {
                var configured = Environment.GetEnvironmentVariable("ROMLAB_BRIDGE_PORT");
                return int.TryParse(configured, out var parsed) ? parsed : DefaultPort;
            }
        }

        private void StartListener()
        {
            if (_listenerThread != null) return;

            _listener = new TcpListener(IPAddress.Loopback, Port);
            _listener.Start();

            _listenerThread = new Thread(ListenLoop) { IsBackground = true, Name = "ROMLab bridge listener" };
            _listenerThread.Start();
        }

        private void ListenLoop()
        {
            while (!_shutdown.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = _listener!.AcceptTcpClient();
                }
                catch (SocketException)
                {
                    return; // Listener stopped during shutdown.
                }

                var thread = new Thread(() => ServeClient(client)) { IsBackground = true };
                thread.Start();
            }
        }

        private void ServeClient(TcpClient client)
        {
            using (client)
            using (var stream = client.GetStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
            {
                string? line;
                while (!_shutdown.IsCancellationRequested && (line = reader.ReadLine()) != null)
                {
                    if (line.Trim().Length == 0) continue;

                    string response;
                    try
                    {
                        var request = Json.ParseRequest(line);
                        response = Dispatch(request);
                    }
                    catch (Exception error)
                    {
                        response = Json.Error(0, "bridge_exception", error.Message);
                    }

                    writer.WriteLine(response);
                }
            }
        }

        /// <summary>
        /// Hands a request to the emulator thread and waits for its answer.
        /// </summary>
        private string Dispatch(BridgeRequest request)
        {
            var item = new WorkItem(request);
            _queue.Add(item);

            if (!item.Completed.Wait(TimeSpan.FromSeconds(30)))
            {
                return Json.Error(request.Id, "emulator_thread_timeout",
                    "The emulator thread did not execute the command within 30s. Is the emulator paused with frame advance disabled?");
            }

            return item.Response ?? Json.Error(request.Id, "no_response", "Command produced no response.");
        }

        /// <summary>
        /// Called by BizHawk on the emulator thread after each frame. This is the
        /// only place ApiHawk is touched.
        /// </summary>
        protected override void UpdateAfter()
        {
            while (_queue.TryTake(out var item))
            {
                try
                {
                    item.Response = Execute(item.Request);
                }
                catch (Exception error)
                {
                    item.Response = Json.Error(item.Request.Id, "command_failed", error.Message);
                }
                finally
                {
                    item.Completed.Set();
                }
            }
        }

        private string Execute(BridgeRequest request)
        {
            var id = request.Id;

            switch (request.Op)
            {
                case "status":
                {
                    var game = CurrentGame();
                    return Json.Status(id, CurrentFrame, new EmulatorStatus
                    {
                        Emulator = "BizHawk",
                        EmulatorVersion = VersionInfo.MainVersion,
                        Core = Apis.Emulation.GetSystemId(),
                        CoreVersion = Apis.Emulation.GetBoardName(),
                        RomSha256 = _romSha256,
                        // Reported for diagnostics only. This is BizHawk's own
                        // database hash, not ROMLab's identity, so it must never
                        // be substituted for RomSha256.
                        GameName = game?.Name,
                        GameHash = game?.Hash,
                        Frame = CurrentFrame,
                        Paused = Apis.EmuClient.IsPaused(),
                    });
                }

                case "reset":
                    Apis.EmuClient.RebootCore();
                    return Json.Ok(id, CurrentFrame);

                case "advance":
                {
                    var frames = Math.Max(0, request.Frames);
                    for (var i = 0; i < frames; i++)
                    {
                        Apis.EmuClient.DoFrameAdvance();
                    }
                    return Json.Ok(id, CurrentFrame);
                }

                case "setInput":
                {
                    var buttons = new Dictionary<string, bool>();
                    foreach (var button in AllButtons)
                    {
                        buttons[button] = request.Buttons.Contains(button, StringComparer.OrdinalIgnoreCase);
                    }
                    Apis.Joypad.Set(buttons, request.Port + 1);
                    return Json.Ok(id, CurrentFrame);
                }

                case "readDomain":
                {
                    var domain = request.Domain;
                    var available = Apis.Memory.GetMemoryDomainList();

                    // A typo in a domain name would otherwise surface as an
                    // opaque core exception. Name the domains this core actually
                    // has, because they differ between Genesis cores.
                    if (!available.Contains(domain))
                    {
                        return Json.Error(id, "unknown_domain",
                            $"Core \"{Apis.Emulation.GetSystemId()}\" has no memory domain \"{domain}\". Available: {string.Join(", ", available)}");
                    }

                    var size = Apis.Memory.GetMemoryDomainSize(domain);
                    if (request.Start < 0 || request.Start + request.Length > size)
                    {
                        return Json.Error(id, "domain_range_out_of_bounds",
                            $"Requested {request.Start}+{request.Length} exceeds \"{domain}\" size {size}.");
                    }

                    var bytes = Apis.Memory.ReadByteRange(request.Start, request.Length, domain);
                    return Json.Domain(id, CurrentFrame, domain, request.Start, Convert.ToBase64String(bytes.ToArray()));
                }

                case "screenshot":
                {
                    var path = Path.Combine(Path.GetTempPath(), $"romlab-frame-{Guid.NewGuid():N}.png");
                    Apis.EmuClient.Screenshot(path);
                    var bytes = File.ReadAllBytes(path);
                    File.Delete(path);
                    return Json.Screenshot(id, CurrentFrame, Apis.EmuClient.BufferWidth(), Apis.EmuClient.BufferHeight(),
                        Convert.ToBase64String(bytes));
                }

                case "captureAudio":
                    // Audio is captured through BizHawk's A/V dump path rather than
                    // ApiHawk. Returning an explicit error beats returning silence
                    // that a report would later describe as a recorded sound event.
                    return Json.Error(id, "not_implemented",
                        "Audio capture requires the A/V writer path; see bridge/README.md.");

                case "saveState":
                {
                    var path = SavestatePath(request.Label);
                    Apis.SaveState.Save(path);
                    return Json.Savestate(id, CurrentFrame, request.Label, Sha256File(path));
                }

                case "loadState":
                {
                    var path = SavestatePath(request.Label);
                    if (!File.Exists(path))
                    {
                        return Json.Error(id, "no_such_savestate", $"No savestate labelled \"{request.Label}\".");
                    }
                    Apis.SaveState.Load(path);
                    return Json.Savestate(id, CurrentFrame, request.Label, Sha256File(path));
                }

                default:
                    return Json.Error(id, "unsupported", $"Unsupported command: {request.Op}");
            }
        }

        private static readonly string[] AllButtons =
        {
            "Up", "Down", "Left", "Right", "A", "B", "C", "Start", "X", "Y", "Z", "Mode",
        };

        private int CurrentFrame => Apis.Emulation.FrameCount();

        private static string SavestatePath(string label)
        {
            var directory = Path.Combine(Path.GetTempPath(), "romlab-savestates");
            Directory.CreateDirectory(directory);
            var safe = string.Join("_", label.Split(Path.GetInvalidFileNameChars()));
            return Path.Combine(directory, safe + ".State");
        }

        /// <summary>
        /// ROMLab's identity is the SHA-256 of the normalised image, and ApiHawk
        /// exposes no way to recover the path of the ROM EmuHawk loaded — the
        /// only identity it offers is <c>IGameInfo.Hash</c>, which is BizHawk's
        /// own database hash in BizHawk's own format and is not comparable.
        ///
        /// So the path is passed in by whoever started the emulator, via
        /// ROMLAB_ROM_PATH. When it is absent the bridge reports an empty hash
        /// rather than guessing, and the client refuses to attach — which is the
        /// correct outcome: captures that cannot be attributed to a known
        /// cartridge are not evidence.
        /// </summary>
        private string ComputeRomSha256()
        {
            var path = Environment.GetEnvironmentVariable("ROMLAB_ROM_PATH");
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return string.Empty;
            return Sha256File(path!);
        }

        private IGameInfo? CurrentGame()
        {
            try { return Apis.Emulation.GetGameInfo(); }
            catch { return null; }
        }

        private static string Sha256File(string path)
        {
            using var sha = System.Security.Cryptography.SHA256.Create();
            using var stream = File.OpenRead(path);
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty).ToLowerInvariant();
        }

        private static string Shorten(string hash) => hash.Length > 12 ? hash.Substring(0, 12) : hash;

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _shutdown.Cancel();
                _listener?.Stop();
                _queue.Dispose();
                _shutdown.Dispose();
            }
            base.Dispose(disposing);
        }

        private sealed class WorkItem
        {
            public WorkItem(BridgeRequest request) => Request = request;

            public BridgeRequest Request { get; }
            public string? Response { get; set; }
            public ManualResetEventSlim Completed { get; } = new ManualResetEventSlim(false);
        }
    }
}
