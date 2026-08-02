import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compareSnapshots,
  excludeIdleMovers,
  narrowAcrossTrials,
  readValue,
  type RepeatedTrial,
} from './ramsearch.js';

/**
 * A toy RAM: a stamina byte that only moves when the action happens, and a
 * frame counter that moves constantly. Separating those two is the entire job.
 */
const STAMINA = 0x100;
const FRAME_COUNTER = 0x200;

function snapshot(stamina: number, frame: number): Uint8Array {
  const ram = new Uint8Array(0x400);
  ram[STAMINA] = stamina;
  ram[FRAME_COUNTER] = frame & 0xff;
  ram[FRAME_COUNTER + 1] = (frame >> 8) & 0xff;
  return ram;
}

describe('differential RAM search', () => {
  it('reads big-endian values by default', () => {
    const bytes = Uint8Array.from([0x12, 0x34]);
    assert.equal(readValue(bytes, 0, 2, true), 0x1234);
    assert.equal(readValue(bytes, 0, 2, false), 0x3412);
  });

  it('finds addresses that decreased', () => {
    const matches = compareSnapshots(snapshot(100, 10), snapshot(70, 11), 'decreased');
    assert.ok(matches.includes(STAMINA));
  });

  it('refuses snapshots covering different regions', () => {
    assert.throws(
      () => compareSnapshots(new Uint8Array(4), new Uint8Array(8), 'changed'),
      /must cover the same region/,
    );
  });

  it('narrows to the addresses that react every single trial', () => {
    // Each trial drains stamina by a different amount and advances the frame
    // counter, so both addresses change in every trial.
    const trials: RepeatedTrial[] = [
      { before: snapshot(100, 10), after: snapshot(70, 20) },
      { before: snapshot(90, 40), after: snapshot(60, 50) },
      { before: snapshot(80, 70), after: snapshot(55, 80) },
    ];

    const candidates = narrowAcrossTrials(trials, 'decreased');
    assert.ok(candidates.includes(STAMINA));
    // The frame counter increased, so a "decreased" search already excludes it.
    assert.ok(!candidates.includes(FRAME_COUNTER));
  });

  it('drops free-running counters using an idle control trial', () => {
    const trials: RepeatedTrial[] = [
      { before: snapshot(100, 10), after: snapshot(70, 20) },
      { before: snapshot(90, 40), after: snapshot(60, 50) },
    ];

    // Search for "changed" so the frame counter survives the first pass.
    const changed = narrowAcrossTrials(trials, 'changed');
    assert.ok(changed.includes(STAMINA));
    assert.ok(changed.includes(FRAME_COUNTER));

    // The control: time passes but the action is never performed.
    const idle: RepeatedTrial = { before: snapshot(70, 100), after: snapshot(70, 130) };
    const narrowed = excludeIdleMovers(changed, idle);

    assert.ok(narrowed.includes(STAMINA));
    assert.ok(!narrowed.includes(FRAME_COUNTER));
  });

  it('returns nothing when no address survives every trial', () => {
    const trials: RepeatedTrial[] = [
      { before: snapshot(100, 10), after: snapshot(70, 20) },
      { before: snapshot(70, 40), after: snapshot(70, 50) },
    ];
    assert.deepEqual(narrowAcrossTrials(trials, 'decreased'), []);
  });

  it('honours a 16-bit search width', () => {
    const before = new Uint8Array(16);
    const after = new Uint8Array(16);
    before[4] = 0x01;
    before[5] = 0x00;
    after[4] = 0x01;
    after[5] = 0x40;

    assert.deepEqual(compareSnapshots(before, after, 'increased', { width: 2 }), [4]);
  });

  it('offsets results by the snapshot base address', () => {
    const before = snapshot(100, 0);
    const after = snapshot(70, 0);
    const matches = compareSnapshots(before, after, 'changed', { baseAddress: 0xff0000 });
    assert.ok(matches.includes(0xff0000 + STAMINA));
  });
});
