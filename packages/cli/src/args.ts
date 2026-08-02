/** Minimal flag parser: `--key value`, `--key=value` and `--flag`. */
export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf('=');

    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }

    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      i += 1;
    } else {
      flags.set(body, true);
    }
  }

  return { command, positional, flags };
}

export class UsageError extends Error {}

export function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError(`Missing required flag --${name}`);
  }
  return value;
}

export function optionalFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name) && args.flags.get(name) !== 'false';
}

/** Accepts decimal or `0x`-prefixed hex, which is how VDP addresses are quoted. */
export function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const raw = optionalFlag(args, name);
  if (raw === undefined) return undefined;

  const value = raw.startsWith('0x') || raw.startsWith('0X') ? parseInt(raw, 16) : Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number, received "${raw}"`);
  return value;
}

/**
 * Parses a scenario step list such as `advance:120,press:A+Right:30,advance:5`.
 * Steps run in order and are recorded in the session's command log.
 */
export interface ScenarioStep {
  kind: 'advance' | 'press';
  frames: number;
  buttons: string[];
}

export function parseScenario(spec: string): ScenarioStep[] {
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [kind, ...rest] = part.split(':');

      if (kind === 'advance') {
        const frames = Number(rest[0] ?? '1');
        if (!Number.isInteger(frames) || frames < 0) {
          throw new UsageError(`advance step needs a frame count, received "${part}"`);
        }
        return { kind: 'advance' as const, frames, buttons: [] };
      }

      if (kind === 'press') {
        const buttons = (rest[0] ?? '').split('+').filter(Boolean);
        const frames = Number(rest[1] ?? '1');
        if (buttons.length === 0) throw new UsageError(`press step needs buttons, received "${part}"`);
        if (!Number.isInteger(frames) || frames < 1) {
          throw new UsageError(`press step needs a frame count, received "${part}"`);
        }
        return { kind: 'press' as const, frames, buttons };
      }

      throw new UsageError(`Unknown scenario step "${part}" (expected advance:N or press:BUTTONS:N)`);
    });
}
