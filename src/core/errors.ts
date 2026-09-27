export class SealError extends Error {
  constructor(public readonly code: string, public readonly fieldId?: string) {
    super(fieldId ? `${code}: ${fieldId}` : code);
    this.name = 'SealError';
  }
}
export function fail(code: string, fieldId?: string): never { throw new SealError(code, fieldId); }
export function ensure(value: unknown, code = 'INVALID_VALUE'): asserts value { if (!value) fail(code); }
export function databaseError(error: unknown): SealError {
  if (error instanceof SealError) return error;
  const wrapped=error as {code?:string;cause?:{code?:string}};
  const code = wrapped?.code??wrapped?.cause?.code;
  return new SealError(code === '23505' || code === '23503' || code === '23502' || code === '23514' ? 'CONSTRAINT_VIOLATION'
    : code === '40001' || code === '40P01' ? 'TRANSACTION_CONFLICT'
    : code === '57014' ? 'DB_TIMEOUT' : 'DATABASE_ERROR');
}
