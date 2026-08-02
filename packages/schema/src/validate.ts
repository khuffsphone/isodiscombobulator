/**
 * A deliberately tiny structural validator.
 *
 * ROMLab's contracts are few and stable, and every dependency added here is a
 * dependency that ships in the desktop app and the CI image. Hand-rolled checks
 * keep the evidence boundary auditable by reading one file.
 */

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export class Validator {
  private readonly errors: string[] = [];

  constructor(private readonly context: string) {}

  fail(path: string, message: string): void {
    this.errors.push(`${this.context}${path ? `.${path}` : ''}: ${message}`);
  }

  require(condition: boolean, path: string, message: string): boolean {
    if (!condition) this.fail(path, message);
    return condition;
  }

  string(value: unknown, path: string, opts: { min?: number; pattern?: RegExp } = {}): boolean {
    if (typeof value !== 'string') {
      this.fail(path, `expected string, received ${describe(value)}`);
      return false;
    }
    if (opts.min !== undefined && value.length < opts.min) {
      this.fail(path, `expected at least ${opts.min} characters`);
      return false;
    }
    if (opts.pattern && !opts.pattern.test(value)) {
      this.fail(path, `does not match ${String(opts.pattern)}`);
      return false;
    }
    return true;
  }

  integer(value: unknown, path: string, opts: { min?: number; max?: number } = {}): boolean {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.fail(path, `expected integer, received ${describe(value)}`);
      return false;
    }
    if (opts.min !== undefined && value < opts.min) {
      this.fail(path, `expected >= ${opts.min}, received ${value}`);
      return false;
    }
    if (opts.max !== undefined && value > opts.max) {
      this.fail(path, `expected <= ${opts.max}, received ${value}`);
      return false;
    }
    return true;
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): value is T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      this.fail(path, `expected one of ${allowed.join(' | ')}, received ${describe(value)}`);
      return false;
    }
    return true;
  }

  object(value: unknown, path: string): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, `expected object, received ${describe(value)}`);
      return false;
    }
    return true;
  }

  array(value: unknown, path: string, opts: { min?: number } = {}): value is unknown[] {
    if (!Array.isArray(value)) {
      this.fail(path, `expected array, received ${describe(value)}`);
      return false;
    }
    if (opts.min !== undefined && value.length < opts.min) {
      this.fail(path, `expected at least ${opts.min} entries`);
      return false;
    }
    return true;
  }

  result(): ValidationResult {
    return { ok: this.errors.length === 0, errors: [...this.errors] };
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const SHA1_PATTERN = /^[0-9a-f]{40}$/;
export const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Throws when a contract is violated. Used at trust boundaries. */
export function assertValid(result: ValidationResult): void {
  if (!result.ok) {
    throw new SchemaViolation(result.errors);
  }
}

export class SchemaViolation extends Error {
  constructor(readonly errors: string[]) {
    super(`Schema violation:\n  - ${errors.join('\n  - ')}`);
    this.name = 'SchemaViolation';
  }
}
