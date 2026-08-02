/**
 * Verification tiers.
 *
 * The single most important rule in ROMLab: a finding may never claim a tier
 * that its evidence does not support. Static byte-pattern scanning of a
 * cartridge produces candidates, never observations. Only the emulator
 * observing the game assembling its own content produces `runtime_observed`,
 * and only controlled manipulation produces `mechanically_verified`.
 */
export const VERIFICATION_STATES = [
  'unverified_candidate',
  'runtime_observed',
  'reproduced',
  'mechanically_verified',
  'human_confirmed',
] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];

const RANK: Record<VerificationState, number> = {
  unverified_candidate: 0,
  runtime_observed: 1,
  reproduced: 2,
  mechanically_verified: 3,
  human_confirmed: 4,
};

export function verificationRank(state: VerificationState): number {
  return RANK[state];
}

export function isVerificationState(value: unknown): value is VerificationState {
  return typeof value === 'string' && value in RANK;
}

/** True when `to` claims more than `from`. Downgrades are always permitted. */
export function isPromotion(from: VerificationState, to: VerificationState): boolean {
  return RANK[to] > RANK[from];
}

/**
 * How a finding was produced. This is deliberately separate from the
 * verification state so the auditor can cross-check the two: a `static_analysis`
 * origin can never justify anything above `unverified_candidate`.
 */
export const EVIDENCE_ORIGINS = [
  'static_analysis',
  'runtime_capture',
  'runtime_reconstruction',
  'controlled_experiment',
  'human_annotation',
  'imported_manifest',
] as const;

export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];

export function isEvidenceOrigin(value: unknown): value is EvidenceOrigin {
  return typeof value === 'string' && (EVIDENCE_ORIGINS as readonly string[]).includes(value);
}

/**
 * The highest tier each origin is permitted to assert on its own. The evidence
 * auditor enforces this; `@romlab/core` refuses to append a violating record.
 */
export const MAX_TIER_BY_ORIGIN: Record<EvidenceOrigin, VerificationState> = {
  static_analysis: 'unverified_candidate',
  imported_manifest: 'unverified_candidate',
  runtime_capture: 'runtime_observed',
  runtime_reconstruction: 'runtime_observed',
  controlled_experiment: 'mechanically_verified',
  human_annotation: 'human_confirmed',
};
