/**
 * Differential RAM search.
 *
 * The workflow this supports: save a state, snapshot RAM, perform exactly one
 * action, snapshot again, rewind, repeat. Addresses that change consistently
 * across repeats — and only across repeats — are candidates for the variable
 * behind the action.
 *
 * Narrowing produces a *candidate*. The address becomes `mechanically_verified`
 * only after it is frozen or written and the visible consequence is observed,
 * which is a separate controlled experiment.
 */

export const COMPARISONS = ['changed', 'unchanged', 'increased', 'decreased'] as const;
export type Comparison = (typeof COMPARISONS)[number];

export interface SearchOptions {
  /** Byte width of the value being tracked. */
  width?: 1 | 2 | 4;
  /** Big-endian for 68K memory; the Genesis CPU is big-endian. */
  bigEndian?: boolean;
  /** Restrict the search to these addresses (the result of a previous pass). */
  within?: readonly number[];
  /** Address of the first byte of the snapshot within its domain. */
  baseAddress?: number;
}

export function readValue(bytes: Uint8Array, offset: number, width: number, bigEndian: boolean): number {
  let value = 0;
  for (let i = 0; i < width; i += 1) {
    const byte = bytes[offset + (bigEndian ? i : width - 1 - i)] ?? 0;
    value = value * 256 + byte;
  }
  return value;
}

/**
 * Returns the addresses whose value satisfies `comparison` between the two
 * snapshots. Addresses are absolute, offset by `baseAddress`.
 */
export function compareSnapshots(
  before: Uint8Array,
  after: Uint8Array,
  comparison: Comparison,
  options: SearchOptions = {},
): number[] {
  const width = options.width ?? 1;
  const bigEndian = options.bigEndian ?? true;
  const base = options.baseAddress ?? 0;

  if (before.length !== after.length) {
    throw new Error(
      `Snapshots differ in length (${before.length} vs ${after.length}); they must cover the same region.`,
    );
  }

  const offsets =
    options.within?.map((address) => address - base) ??
    range(0, before.length - width + 1, width === 1 ? 1 : width);

  const matches: number[] = [];

  for (const offset of offsets) {
    if (offset < 0 || offset + width > before.length) continue;

    const a = readValue(before, offset, width, bigEndian);
    const b = readValue(after, offset, width, bigEndian);

    const hit =
      comparison === 'changed'
        ? a !== b
        : comparison === 'unchanged'
          ? a === b
          : comparison === 'increased'
            ? b > a
            : b < a;

    if (hit) matches.push(base + offset);
  }

  return matches;
}

export interface RepeatedTrial {
  before: Uint8Array;
  after: Uint8Array;
}

/**
 * Intersects the results of repeated identical trials.
 *
 * One trial finds hundreds of addresses, most of them timers, animation
 * counters and RNG churn. Requiring the same address to react the same way to
 * the same action every time is what removes them.
 */
export function narrowAcrossTrials(
  trials: readonly RepeatedTrial[],
  comparison: Comparison,
  options: SearchOptions = {},
): number[] {
  if (trials.length === 0) return [];

  let candidates: number[] | undefined;

  for (const trial of trials) {
    const matches = compareSnapshots(trial.before, trial.after, comparison, {
      ...options,
      ...(candidates ? { within: candidates } : {}),
    });
    candidates = matches;
    if (candidates.length === 0) break;
  }

  return candidates ?? [];
}

/**
 * Rejects addresses that also move when the action is *not* performed.
 *
 * Without this control pass a free-running frame counter looks exactly like a
 * stamina meter.
 */
export function excludeIdleMovers(
  candidates: readonly number[],
  idle: RepeatedTrial,
  options: SearchOptions = {},
): number[] {
  const movers = new Set(
    compareSnapshots(idle.before, idle.after, 'changed', { ...options, within: candidates }),
  );
  return candidates.filter((address) => !movers.has(address));
}

function range(start: number, end: number, step: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i += step) out.push(i);
  return out;
}
