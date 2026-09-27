import { ensure } from '../../../core/errors.js';
import { Sealed, type Registration } from './native.js';

export function mapRawRow(reg: Registration, row: Record<string, unknown>, columns: Record<string, string>,
  fields: Iterable<string>, required: boolean): Record<string, unknown> {
  ensure(!!columns[reg.row] && (!reg.scope || !!columns[reg.scope]), 'INVALID_VALUE');
  if (required) ensure(Object.hasOwn(row, columns[reg.row]) && (!reg.scope || Object.hasOwn(row, columns[reg.scope!])), 'INVALID_CANDIDATE_SHAPE');
  const mapped: Record<string, unknown> = { [reg.row]: row[columns[reg.row]],
    ...(reg.scope ? { [reg.scope]: row[columns[reg.scope]] } : {}) };
  for (const key of fields) {
    const name = columns[key];
    if (!name) { ensure(!required, 'INVALID_CANDIDATE_SHAPE'); continue; }
    if (!Object.hasOwn(row, name)) {
      ensure(!required, 'INVALID_CANDIDATE_SHAPE');
      continue;
    }
    const value = row[name];
    mapped[key] = value === null ? null : Sealed.fromDriver(value, reg.fields.get(key)!);
  }
  return mapped;
}
