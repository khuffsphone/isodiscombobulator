# ROMLab BizHawk bridge

The Windows-side half of ROMLab's emulator integration: a BizHawk *external tool*
that exposes deterministic frame control and synchronised state capture over the
ROMLab bridge protocol.

## Status

**Compiles cleanly against BizHawk 2.9.1; not yet run inside EmuHawk.**

What is verified:

- Builds with zero warnings against the real BizHawk 2.9.1 assemblies
  (`-warnaserror`), on every CI run — so every ApiHawk call it makes is known to
  exist with the signature it expects.
- The type carries `[ExternalTool("ROMLab Bridge")]` and derives from
  `ToolFormBase`, so BizHawk's tool loader will discover it.
- The wire protocol is tested from the TypeScript side against a fake bridge over
  real TCP: id correlation, out-of-order replies, chunked frames, error
  responses, timeouts and malformed input.
- The adapter's identity and version gates are tested against a fake bridge.

What is **not** verified: that it behaves correctly inside a live EmuHawk
process. Frame-advance determinism, savestate round-tripping and memory-domain
correctness all need a Windows machine. Until that happens, no BizHawk capture
should be treated as runtime evidence.

BizHawk 2.9.1's `EmuHawk.exe` targets **.NET Framework 4.8** (confirmed from its
shipped `EmuHawk.exe.config` and assembly metadata), which is why this project
targets `net48`.

## Protocol

Newline-delimited JSON over TCP on loopback. One request per line, one response
per line, correlated by `id`:

```json
{"id":7,"command":{"op":"advance","frames":1}}
{"id":7,"ok":true,"frame":182442,"result":{"kind":"none"}}
```

The canonical definition is `packages/schema/src/protocol.ts`. That file is the
specification; `Json.cs` is an implementation of it. If the two disagree, the
TypeScript wins and the C# is the bug.

The port defaults to `51735`, overridden with `ROMLAB_BRIDGE_PORT`.

## ROM identity

**ApiHawk cannot report the path of the ROM EmuHawk loaded.** `IEmuClientApi`
has `OpenRom` but no `GetRomPath`, and the only identity available is
`IGameInfo.Hash` — BizHawk's own database hash, in BizHawk's own format, which
is not comparable to ROMLab's SHA-256 of the normalised image.

So the launcher supplies it: `BizHawkAdapter` sets **`ROMLAB_ROM_PATH`** in
EmuHawk's environment, and the bridge hashes that file.

When the variable is absent the bridge reports an **empty** `romSha256` and the
client refuses to attach, with an error explaining the fix. That is deliberate —
attaching to an emulator someone else started would otherwise silently attribute
captures to an unverified cartridge. `gameName` and `gameHash` are reported
alongside for diagnostics and must never be used as an identity check.

## Threading

Every ApiHawk call must run on the emulator thread. The listener thread enqueues
a work item and blocks; `UpdateAfter()` — which BizHawk invokes on the emulator
thread after each frame — drains the queue and signals completion. Calling the
API directly from a socket thread appears to work in light testing and then
corrupts emulator state under load, so it is worth keeping this indirection even
though it costs a frame of latency.

## Building

CI builds this on Linux using `Microsoft.NETFramework.ReferenceAssemblies`, so
no Windows machine is needed just to check it compiles:

```bash
curl -sSL -o bizhawk.zip \
  https://github.com/TASEmulators/BizHawk/releases/download/2.9.1/BizHawk-2.9.1-win-x64.zip
unzip -q bizhawk.zip -d ~/bizhawk

dotnet build bridge/ROMLab.BizHawk/ROMLab.BizHawk.csproj \
  -c Release -p:BizHawkDir="$HOME/bizhawk" -warnaserror
```

To actually run it, copy `ROMLab.BizHawk.dll` into `<BizHawk>\ExternalTools\`
and open **Tools → External Tool → ROMLab Bridge**, or let ROMLab pass
`--open-ext-tool-dll=` when it launches EmuHawk.

## Version pinning

Captures taken under different emulator or core versions are not comparable, so
`BizHawkAdapter` refuses a mismatch rather than warning about it. Pass
`expectedVersion` / `expectedCore`.

The API surface used here is pinned to BizHawk 2.9.1. ApiHawk has changed shape
across releases, so a different BizHawk version may need adjustments — the CI
bridge job is what will tell you.

## Verification checklist

Before any BizHawk capture is treated as runtime evidence:

1. ~~Builds clean against the pinned BizHawk with no reflection fallbacks.~~ **Done — enforced in CI.**
2. The tool loads in EmuHawk and the bridge accepts a TCP connection.
3. `status` reports the same ROM SHA-256 that ROMLab computed on import.
4. `advance` moves the frame counter by exactly the requested count, and
   repeating a command log from a savestate lands on identical frames.
5. `readDomain` returns byte-identical dumps for the same frame across two runs.
6. Screenshot dimensions match the core's buffer size.
7. Savestate save/load round-trips to an identical memory hash.
8. A reconstruction from a real capture produces a recognisable fighter pose.
9. Twenty consecutive scenario runs complete without a deadlock or a mismatch.

## Known gaps

- **`captureAudio` returns `not_implemented`.** Genesis audio needs BizHawk's A/V
  writer path rather than ApiHawk, and returning a silent buffer would put a
  fabricated "recorded sound event" into the evidence ledger.
- **VDP registers are not readable**, so `romlab reconstruct` needs an explicit
  `--sat-start`. The Genesis cores expose no VDP-register memory domain; closing
  this needs a dedicated op backed by core-specific access.
- **Layer isolation is available but unused.** `IEmulationApi.SetRenderPlanes(bool[])`
  exists in 2.9.1 and is the hook for separating ring, crowd, HUD and fighters
  into distinct captures. Not yet wired into the protocol.
