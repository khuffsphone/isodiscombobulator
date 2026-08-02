import { createHash } from 'node:crypto';

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha1(data: Uint8Array | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * Deterministic JSON with sorted keys.
 *
 * The ledger hash chain and every artifact digest depend on two runs of the
 * same analyzer producing byte-identical serialisations, so key order can never
 * be left to insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    sorted[key] = canonicalise(source[key]);
  }
  return sorted;
}

export function hashRecord(value: unknown): string {
  return sha256(canonicalJson(value));
}
