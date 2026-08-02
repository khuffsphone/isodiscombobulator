# ROMLab AI

Runtime-first ROM investigation: import a cartridge, watch it run under a
controlled emulator, reconstruct what it actually put on screen, and produce
reports whose every claim cites the frame it rests on.

This repository is ROMLab 0.2 — the **BizHawk Capture Laboratory** foundation.
EHRDB is the first supported project and Sega Genesis the first target platform,
but nothing in the core is Genesis-specific.

## The one rule

A Genesis cartridge does not store a fighter as a picture. It stores 8×8 tiles
that the game decompresses into VRAM and assembles through the sprite attribute
table using palettes, flips, priorities and link order. Scanning cartridge bytes
for "sprites" produces tile soup that *looks* like progress.

So ROMLab separates two things and refuses to blur them:

- **Candidate discovery** — static scanning. Useful for deciding where to point
  the emulator. Never evidence of what anything *is*.
- **Runtime evidence** — captured VRAM, CRAM, sprite tables and RAM at a known
  frame, from a known emulator build, running a known ROM.

The evidence auditor enforces this in code. A finding produced by static
analysis cannot be labelled `runtime_observed` no matter how confident the
heuristic was, and the ledger refuses to store one that tries.

## Verification tiers

| Tier | Means |
| --- | --- |
| `unverified_candidate` | A byte pattern is structurally compatible with something. |
| `runtime_observed` | Seen in emulator state at a cited frame and capture. |
| `reproduced` | Two independent observations agree. |
| `mechanically_verified` | The value was manipulated and the consequence observed. |
| `human_confirmed` | A person reviewed and signed off. |

Rules the auditor applies (`packages/schema/src/evidence.ts`):

- Static analysis is capped at candidate tier, always.
- Anything at `runtime_observed` or above must cite a capture id **and** a frame.
- `reproduced` requires at least two independent observations in its lineage.
- `mechanically_verified` requires a recorded `experiment:*` transformation.
- A finding cannot inherit a higher tier than the records it derives from, so a
  candidate cannot be laundered into an observation through a lineage chain.

## Quick start

Requires Node 22.5+ (the workspace store uses the built-in `node:sqlite`).

```bash
npm ci
npm run verify          # typecheck, build, 95 tests across 20 suites
node scripts/smoke.mjs  # full CLI loop against a synthetic cartridge
```

Then run the loop yourself. The mock adapter needs no emulator and no ROM:

```bash
npm run build
alias romlab='node --disable-warning=ExperimentalWarning packages/cli/dist/bin.js'

romlab init    --workspace /tmp/ehrdb --name EHRDB
romlab import  --workspace /tmp/ehrdb --rom-path /path/to/cartridge.bin
romlab scan    --workspace /tmp/ehrdb --rom-path /path/to/cartridge.bin
romlab capture --workspace /tmp/ehrdb --rom-path /path/to/cartridge.bin \
               --adapter mock --scenario standing-jab \
               --steps 'advance:60,press:A+Right:10' \
               --domains 'VRAM,CRAM,68K RAM' --screenshot
romlab reconstruct --workspace /tmp/ehrdb --capture cap-0001 \
               --sat-start 0xF000 --write-images
romlab audit   --workspace /tmp/ehrdb
romlab report  --workspace /tmp/ehrdb --out report.md
romlab export  --workspace /tmp/ehrdb --out public.json
```

`romlab help` documents every flag.

## What leaves the machine

The ROM is referenced by hash and path and is **never** copied into the
workspace or any export.

- A **public** export carries claims, provenance, hashes and metrics. No ROM, no
  savestates, no memory dumps, no screenshots, no reconstructions — not even the
  operator's local ROM path.
- A **private research** export carries full detail and may only be written
  beneath a directory literally named `private-repro`, so the boundary is
  visible in the filesystem before anyone zips a folder.

Reconstructed imagery always lands under `private-repro/`. `assertPrivateDestination`
enforces it and a test asserts a public package leaks nothing.

## Layout

```
packages/
  schema/            Evidence, capture and protocol contracts + the auditor
  core/              Workspace, SQLite store, hash-chained evidence ledger, exports
  platform-genesis/  ROM identity, VDP decode, runtime reconstruction, RAM search
  emulator/          Adapter contract, bridge client, BizHawk adapter, mock adapter
  cli/               The `romlab` command
bridge/
  ROMLab.BizHawk/    C# ApiHawk external tool (Windows; see bridge/README.md)
scripts/smoke.mjs    End-to-end CLI smoke test
```

Dependency direction is one-way: `cli → emulator → platform-genesis → core → schema`.

## The evidence ledger

Findings are append-only and hash-chained: each record commits to the one before
it. A workspace can therefore prove its findings were not rewritten after a
report was published, and `romlab audit` recomputes the chain. A correction is a
new record that supersedes an older one, never an edit.

## Status

Working and tested:

- Workspace lifecycle, migrations, provenance store, hash-chained ledger
- The evidence auditor and its tier rules
- Genesis ROM identity: SMD de-interleaving, SHA-1/256, header parse, checksum
- Genesis VDP decode: tiles, CRAM palettes, sprite table link-walking
- Runtime sprite reconstruction, including multi-sprite object grouping
- Differential RAM search with repeated trials and idle-control rejection
- The bridge wire protocol, tested against a fake bridge over real TCP
- The deterministic mock adapter and the whole capture → reconstruct → report loop
- Export boundary enforcement
- The C# BizHawk external tool **compiles cleanly against BizHawk 2.9.1** with
  warnings as errors, on every CI run — so every ApiHawk call it makes is known
  to exist with the signature it expects

Not yet verified:

- **The bridge has not been run inside a live EmuHawk.** Frame-advance
  determinism, savestate round-tripping and memory-domain correctness all need a
  Windows machine before any BizHawk capture can honestly be called runtime
  evidence. See `bridge/README.md` for the remaining checklist.
- Audio capture returns `not_implemented` rather than a silent buffer, because a
  fabricated "recorded sound event" in the ledger is worse than a gap.
- No Electron shell yet; the CLI is the interface.
- `reconstruct` requires an explicit `--sat-start`. The sprite table address
  lives in VDP register 5, which BizHawk's Genesis cores do not expose as a
  memory domain, so ROMLab asks rather than guesses.

## Next

1. Run the bridge inside a live EmuHawk on Windows and work the
   `bridge/README.md` checklist.
2. Emit synchronised screenshot, VRAM, CRAM, VSRAM, sprite-table, RAM, input,
   savestate and WAV artifacts under `romlab.capture.v1`.
3. Plane/layer separation so ring, crowd, HUD and fighters are catalogued apart.
4. Event-based audio capture with silence trimming.
5. The EHRDB guided capture campaign.
6. Instrument the remake with the same observation schema, then synchronised
   ROM-versus-remake comparison.
