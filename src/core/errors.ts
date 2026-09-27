export class SealError extends Error {
  constructor(public readonly code: string, public readonly fieldId?: string, options?: ErrorOptions & { detail?: string }) {
    super(fieldId ? `${code}: ${fieldId}` : options?.detail ? `${code}: ${options.detail}` : code, options);
    this.name = 'SealError';
  }
}
export function fail(code: string, fieldId?: string): never { throw new SealError(code, fieldId); }
export function ensure(value: unknown, code = 'INVALID_VALUE'): asserts value { if (!value) fail(code); }
const diagnosticKeys = ['code', 'constraint', 'table', 'column', 'schema'] as const;
export function driverError(error: unknown): Record<string, unknown> | undefined {
  let current = error;
  const seen = new Set<unknown>();
  let coded: Record<string, unknown> | undefined;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (typeof (current as { code?: unknown }).code === 'string') coded = current as Record<string, unknown>;
    const next = (current as { cause?: unknown }).cause;
    if (!next || typeof next !== 'object') return coded ?? current as Record<string, unknown>;
    current = next;
  }
  return coded;
}
export function unsupportedTransaction(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (typeof (current as { code?: unknown }).code === 'string') return false;
    current = (current as { cause?: unknown }).cause;
  }
  return /(?:transactions? (?:are |is )?not supported|no transactions? support|transaction method is not supported)/i.test(String(error));
}
function safeCause(error: unknown): Error | undefined {
  let source = error;
  const seen = new Set<unknown>();
  while (source && typeof source === 'object' && !seen.has(source)) {
    seen.add(source);
    const next = (source as { cause?: unknown }).cause;
    if (!next || typeof next !== 'object') break;
    source = next;
  }
  if (!source || typeof source !== 'object') return undefined;
  const fields = source as Record<string, unknown>;
  // Drizzle's wrapper message contains SQL and params. Only the inner driver error is safe to summarize.
  if ('query' in fields || 'params' in fields) return undefined;
  const message = typeof fields.message === 'string' ? fields.message : 'Database error';
  const cause = new Error(message);
  cause.name = typeof fields.name === 'string' ? fields.name : 'Error';
  for (const key of diagnosticKeys) if (typeof fields[key] === 'string')
    Object.defineProperty(cause, key, { value: fields[key], enumerable: true });
  return cause;
}
export function databaseError(error: unknown): SealError {
  if (error instanceof SealError) return error;
  const code = driverError(error)?.code;
  return new SealError(code === '23505' || code === '23503' || code === '23502' || code === '23514' ? 'CONSTRAINT_VIOLATION'
    : code === '40001' || code === '40P01' ? 'TRANSACTION_CONFLICT'
    : code === '57014' ? 'DB_TIMEOUT' : 'DATABASE_ERROR', undefined, { cause: safeCause(error) });
}
