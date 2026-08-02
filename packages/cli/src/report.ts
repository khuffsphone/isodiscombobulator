import type { Workspace } from '@romlab/core';
import {
  VERIFICATION_STATES,
  auditAll,
  verificationRank,
  type EvidenceRecord,
  type RomRecord,
  type VerificationState,
} from '@romlab/schema';

const TIER_LABEL: Record<VerificationState, string> = {
  unverified_candidate: 'Unverified candidate',
  runtime_observed: 'Runtime observed',
  reproduced: 'Reproduced',
  mechanically_verified: 'Mechanically verified',
  human_confirmed: 'Human confirmed',
};

/**
 * Renders an investigation report.
 *
 * The report leads with the verification breakdown rather than with findings,
 * because "we have 400 findings" means nothing until a reader knows that 396 of
 * them are guesses. Every claim carries the frame, address or offset it rests on.
 */
export function renderReport(workspace: Workspace, romSha256: string): string {
  const rom = workspace.getRom(romSha256);
  if (!rom) throw new Error(`ROM ${romSha256} is not in this workspace.`);

  const evidence = workspace.ledger.query({ romSha256 });
  const captures = workspace.listCaptures({ romSha256 });
  const issues = auditAll(evidence);
  const chain = workspace.ledger.verifyChain();

  const lines: string[] = [];
  const push = (line = '') => lines.push(line);

  push(`# ROMLab investigation report`);
  push();
  push(`Workspace: **${workspace.manifest.name}**  `);
  push(`Generated: ${new Date().toISOString()}  `);
  push(`ROMLab: ${workspace.manifest.romlabVersion}`);
  push();

  push('## Cartridge identity');
  push();
  push('| Field | Value |');
  push('| --- | --- |');
  push(`| SHA-256 | \`${rom.sha256}\` |`);
  push(`| SHA-1 | \`${rom.sha1}\` |`);
  push(`| Platform | ${rom.platform} |`);
  push(`| Size | ${rom.byteLength.toLocaleString()} bytes |`);
  push(`| Container | ${rom.sourceFormat} |`);
  for (const [key, value] of headerRows(rom)) push(`| ${key} | ${value} |`);
  push();
  push('_The ROM itself is not stored in this workspace and is not included in any export._');
  push();

  push('## Evidence by verification tier');
  push();
  push('| Tier | Findings |');
  push('| --- | --- |');
  for (const tier of VERIFICATION_STATES) {
    push(`| ${TIER_LABEL[tier]} | ${evidence.filter((e) => e.verification === tier).length} |`);
  }
  push();

  const runtime = evidence.filter((e) => verificationRank(e.verification) >= verificationRank('runtime_observed'));
  if (runtime.length === 0) {
    push(
      '> No runtime-observed evidence yet. Everything below is candidate discovery: ' +
        'byte patterns that are structurally compatible with game data, not content the game was seen to use.',
    );
    push();
  }

  push('## Captures');
  push();
  if (captures.length === 0) {
    push('_No captures recorded._');
  } else {
    push('| Capture | Frame | Scenario | Emulator | Domains | Artifacts |');
    push('| --- | --- | --- | --- | --- | --- |');
    for (const capture of captures) {
      push(
        `| \`${capture.captureId}\` | ${capture.frame} | ${capture.scenario ?? '—'} | ` +
          `${capture.emulator.name} ${capture.emulator.version} / ${capture.emulator.core} | ` +
          `${capture.domains.map((d) => d.domain).join(', ') || '—'} | ` +
          `${capture.artifacts.map((a) => a.kind).join(', ') || '—'} |`,
      );
    }
  }
  push();

  push('## Findings');
  push();
  for (const tier of [...VERIFICATION_STATES].reverse()) {
    const inTier = evidence.filter((e) => e.verification === tier);
    if (inTier.length === 0) continue;

    push(`### ${TIER_LABEL[tier]} (${inTier.length})`);
    push();
    for (const record of inTier.slice(0, 50)) {
      push(`- **${record.subject}**  `);
      push(`  ${describeLocator(record)}  `);
      push(`  confidence ${record.confidence.toFixed(2)} · produced by \`${record.producer.name}@${record.producer.version}\``);
    }
    if (inTier.length > 50) push(`- _…and ${inTier.length - 50} more (see the export package)._`);
    push();
  }

  push('## Integrity');
  push();
  push(`- Evidence ledger head: \`${workspace.ledger.headHash().slice(0, 16)}…\``);
  push(`- Ledger chain intact: ${chain.ok ? 'yes' : `**no** — broken at ${(chain as { brokenAt: string }).brokenAt}`}`);
  push(`- Auditor issues: ${issues.length}`);
  for (const issue of issues.slice(0, 20)) {
    push(`  - \`${issue.rule}\` on ${issue.recordId}: ${issue.message}`);
  }
  push();

  push('## Next actions');
  push();
  for (const task of nextActions(evidence, captures.length)) push(`- ${task}`);
  push();

  return lines.join('\n');
}

function headerRows(rom: RomRecord): [string, string][] {
  const header = rom.header as Record<string, unknown>;
  const rows: [string, string][] = [];

  for (const key of ['internationalTitle', 'domesticTitle', 'serial', 'region', 'copyright']) {
    const value = header[key];
    if (typeof value === 'string' && value.length > 0) rows.push([key, value]);
  }

  if (typeof header['checksumMatches'] === 'boolean') {
    rows.push(['checksum', header['checksumMatches'] ? 'matches header' : '**does not match header**']);
  }

  return rows;
}

function describeLocator(record: EvidenceRecord): string {
  const parts: string[] = [];
  const l = record.locator;

  if (l.frame !== undefined) parts.push(`frame ${l.frame}`);
  if (l.captureId) parts.push(`capture \`${l.captureId}\``);
  if (l.domain) {
    const start = l.domainStart !== undefined ? ` @ 0x${l.domainStart.toString(16).toUpperCase()}` : '';
    parts.push(`${l.domain}${start}`);
  }
  if (l.romOffset !== undefined) {
    parts.push(`ROM 0x${l.romOffset.toString(16).toUpperCase()}${l.romLength ? ` +${l.romLength}` : ''}`);
  }
  if (l.artifactPath) parts.push(`artifact \`${l.artifactPath}\``);

  return parts.length > 0 ? parts.join(' · ') : '_no locator_';
}

/**
 * Concrete next steps derived from what the workspace is missing. Kept blunt on
 * purpose: the report should say what would raise the evidence tier, not
 * congratulate the operator on the count of candidates.
 */
function nextActions(evidence: readonly EvidenceRecord[], captureCount: number): string[] {
  const actions: string[] = [];
  const runtimeCount = evidence.filter(
    (e) => verificationRank(e.verification) >= verificationRank('runtime_observed'),
  ).length;

  if (captureCount === 0) {
    actions.push(
      'Capture at least one frame through an emulator adapter. Without a capture nothing here can rise above candidate tier.',
    );
  }

  if (runtimeCount === 0 && captureCount > 0) {
    actions.push('Run `romlab reconstruct` against a capture to turn VDP state into runtime-observed objects.');
  }

  if (evidence.some((e) => e.kind === 'graphics_candidate')) {
    actions.push(
      'Confirm or discard the tile-bank candidates by capturing VRAM at a frame where the corresponding art is on screen.',
    );
  }

  if (!evidence.some((e) => e.kind === 'ram_variable')) {
    actions.push(
      'Run a differential RAM search with repeated trials and an idle control to identify a gameplay variable.',
    );
  }

  const reproduced = evidence.filter(
    (e) => verificationRank(e.verification) >= verificationRank('reproduced'),
  ).length;
  if (runtimeCount > 0 && reproduced === 0) {
    actions.push('Repeat a scenario from a savestate to promote runtime observations to reproduced.');
  }

  return actions.length > 0 ? actions : ['No blocking gaps detected in this workspace.'];
}
