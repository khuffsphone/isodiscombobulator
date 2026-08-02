# ROMLab architecture

## Why runtime-first

The browser prototype that preceded this build proved that importing and
browsing a cartridge works, and simultaneously proved that blind static scanning
produces unidentified tile grids and guessed palettes rather than game content.
That is not a tuning problem. A Genesis game stores graphics as 8×8 tiles that it
decompresses into VRAM and composes at draw time through the sprite attribute
table — tile index, palette line, size, position, flips, link order, priority —
often behind game-specific compression. Audio is sequencer data, FM instrument
parameters, PSG commands and driver code, not WAV files.

So ROMLab lets the game assemble its own content and captures the result.

The consequence for the architecture is that **the emulator is not a viewer, it
is the measurement instrument**, and everything downstream is organised around
attributing observations to an exact machine state.

## Layers

```
cli  ──▶  emulator  ──▶  platform-genesis  ──▶  core  ──▶  schema
                    └────────────────────────────┘
```

### `@romlab/schema`

Contracts and the auditor. No I/O, no dependencies. Defines verification tiers,
evidence records, `romlab.capture.v1`, the frame-command vocabulary and the
bridge wire format.

This package is the specification. The C# bridge implements
`protocol.ts`; where they disagree, the TypeScript is right.

### `@romlab/core`

Workspace lifecycle over `node:sqlite`, append-only hash-chained evidence
ledger, migrations, structured logging, and the export boundary.

The ledger is the trust anchor. Each row stores `prev_hash` and `record_hash`
where `record_hash = sha256(canonical_json({prevHash, record}))`. Canonical JSON
(sorted keys, dropped `undefined`) makes the hash stable across runs.
`verifyChain()` recomputes the whole chain and names the first broken record.

### `@romlab/platform-genesis`

Everything Genesis-specific:

- **Containers** — SMD detection and de-interleaving, so `.bin` and `.smd` dumps
  of the same cartridge produce the same identity.
- **Header** — the Sega header at 0x100 and an independent checksum recompute.
- **VDP** — 4bpp tile decode, CRAM colour decode against the measured output
  ladder, sprite attribute table link-walking, sprite and plane rendering.
- **Reconstruction** — grouping hardware sprites into coherent objects.
- **RAM search** — differential search with repeated trials and idle controls.
- **Static scanners** — candidate discovery, clearly labelled as such.

### `@romlab/emulator`

The adapter contract and its implementations. Adapters expose exactly one
vocabulary — `FrameCommand` — which is what makes a session portable: a recorded
scenario is a command list, and any adapter honouring it reproduces the run.

`CaptureSession` drives an adapter and turns what it reports into workspace
evidence, logging every command with the frame it landed on.

### `@romlab/cli`

The `romlab` command and the Markdown report renderer.

## The capture

`romlab.capture.v1` is one synchronised observation of the machine at one exact
frame. It carries the ROM SHA-256, capture and session ids, the frame number,
emulator name/version/core, the input held on that frame, hashed memory-domain
dumps and hashed derived artifacts.

Two rules make it useful:

1. **A capture is refused if its ROM hash is not imported in the workspace.**
   A capture from another cartridge is not evidence about this one.
2. **Dumps are re-hashed before reconstruction.** If a dump on disk no longer
   matches its manifest, `reconstructCapture` refuses rather than analysing bytes
   that are not the recorded evidence.

## Sprite reconstruction

The sprite attribute table is a linked list, not an array: entry 0 names the
next entry and a link of 0 ends it. Walking the links — rather than reading all
80 slots — is what distinguishes sprites the VDP actually drew this frame from
stale slots left over from an earlier scene. A cycle-detecting visited set keeps
a corrupt table from spinning.

Within a sprite, cells run **column-major**: for an H×V sprite the cell at
column `c`, row `r` is `tileIndex + c * V + r`. Getting this backwards produces
a scrambled figure that still looks vaguely plausible, so it is pinned by test.
Flips mirror the cell layout as well as the pixels.

Objects are then formed by union-find over overlapping bounding boxes, because
the VDP caps a hardware sprite at 4×4 cells and a fighter is drawn from several.
Turning "seven sprites" back into "one fighter" is the difference between a
browsable asset and a pile of tile grids.

### The `--sat-start` gap

The sprite table address lives in VDP register 5. BizHawk's Genesis cores do not
expose VDP registers as a memory domain, so ROMLab cannot read it back from a
capture and requires the caller to supply it. Defaulting to a common address
would silently reconstruct plausible-looking objects from the wrong bytes.

Closing this properly means adding a register-read path to the bridge.

## The bridge

Newline-delimited JSON over loopback TCP, one request and one response per line,
correlated by `id`. Text was chosen over a binary protocol because when a
capture desyncs, an operator can attach to the port and read the conversation.

On the C# side, every ApiHawk call runs on the emulator thread: the socket
thread enqueues a work item and blocks, and `UpdateAfter()` drains the queue.
Calling ApiHawk from a socket thread appears to work under light testing and
corrupts state under load.

Input goes through the joypad API, never synthesised keystrokes — simulated
input is not reproducible, and reproducibility is the product.

## Export boundary

Two modes, enforced in `core/src/export.ts`:

- `public` strips the operator's ROM path, replaces capture manifests with
  hash-only summaries, and drops artifact paths from evidence locators. Hashes
  survive so a holder of the private package can prove the two describe the same
  bytes.
- `private_research` keeps everything and may only be written beneath a
  `private-repro` directory.

## Testing strategy

Everything is exercised on Linux CI with no ROM and no emulator:

- Synthetic cartridges are built by `fixtures.ts` with a valid header, a correct
  checksum and a deterministic LCG payload, so hashes are stable across runs.
- A synthetic VDP state contains a known two-sprite object whose tiles are each
  flooded with a distinct palette index, so a test can assert exactly which tile
  landed where.
- The bridge client is tested against a real TCP server standing in for the C#
  tool, covering id correlation, out-of-order replies, chunk splitting, error
  responses, timeouts and malformed input.
- The mock adapter implements a tiny deterministic machine — stamina drains
  while A is held, the figure translates while Right is held — so differential
  RAM search has a real answer to find and the whole loop has something to
  reconstruct.
