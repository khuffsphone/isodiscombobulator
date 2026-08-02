# ROMLab BizHawk bridge

The Windows-side half of ROMLab's emulator integration: a BizHawk *external tool*
that exposes deterministic frame control and synchronised state capture over the
ROMLab bridge protocol.

## Status

**Not yet compiled or run against a real BizHawk install.** The TypeScript client
(`packages/emulator/src/bridge.ts`) is exercised against a fake bridge in CI, so
the wire protocol is tested; the C# side is written against the BizHawk 2.9.1
ApiHawk surface and still needs a Windows build plus a live smoke test. Until
that happens, no capture in a ROMLab workspace can honestly be labelled
`runtime_observed` from BizHawk — use the mock adapter, which is explicit about
being synthetic.

Verifying this is the next milestone. See "Verification checklist" below.

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

The port defaults to `51735` and is overridden with the `ROMLAB_BRIDGE_PORT`
environment variable, which `BizHawkAdapter` sets when it launches EmuHawk.

## Threading

Every ApiHawk call must run on the emulator thread. The listener thread enqueues
a work item and blocks; `UpdateAfter()` — which BizHawk invokes on the emulator
thread after each frame — drains the queue and signals completion. Calling the
API directly from a socket thread appears to work in light testing and then
corrupts emulator state under load, so it is worth keeping this indirection even
though it costs a frame of latency.

## Building

```
dotnet build bridge/ROMLab.BizHawk/ROMLab.BizHawk.csproj -c Release -p:BizHawkDir="C:\BizHawk-2.9.1"
```

Copy `ROMLab.BizHawk.dll` into `<BizHawk>\ExternalTools\`, then open it from
**Tools → External Tool → ROMLab Bridge**, or let ROMLab pass
`--open-ext-tool-dll=` when it launches EmuHawk.

## Version pinning

Captures taken under different emulator or core versions are not comparable, so
`BizHawkAdapter` refuses a mismatch rather than warning about it. Record the
pinned version in the workspace and pass it as `expectedVersion` /
`expectedCore`.

The API signatures used here are pinned to BizHawk 2.9.1. ApiHawk has changed
shape across releases — `DoFrameAdvance`, `ReadByteRange` and the `ApiContainer`
injection point have all moved at least once — so a different BizHawk version
will likely need adjustments in `RomLabBridgeForm.cs`.

## Verification checklist

Before any BizHawk capture is treated as runtime evidence:

1. Builds clean against the pinned BizHawk with no reflection fallbacks.
2. `status` reports the same ROM SHA-256 that ROMLab computed on import.
3. `advance` moves the frame counter by exactly the requested count, and
   repeating a command log from a savestate lands on identical frames.
4. `readDomain` returns byte-identical dumps for the same frame across two runs.
5. Screenshot dimensions match the core's buffer size.
6. Savestate save/load round-trips to an identical memory hash.
7. Twenty consecutive scenario runs complete without a deadlock or a mismatch.

## Not implemented

`captureAudio` returns `not_implemented`. Genesis audio needs BizHawk's A/V
writer path rather than ApiHawk, and returning a silent buffer would put a
fabricated "recorded sound event" into the evidence ledger. An explicit error is
the correct answer until the A/V path is wired up.
