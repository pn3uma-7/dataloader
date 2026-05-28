import type { ColumnType } from '../types';

// Spec §12: type inference rules applied to sampled column values
const isInteger = (v: string) => /^-?\d+$/.test(v.trim());
const isNumeric = (v: string) => /^-?\d*\.?\d+$/.test(v.trim());
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
const isDatetime = (v: string) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v.trim());
const isBoolean = (v: string) => /^(true|false|0|1)$/i.test(v.trim());

export function inferType(values: string[]): ColumnType {
  const nonEmpty = values.filter((v) => v.trim() !== '');
  if (nonEmpty.length === 0) return 'VARCHAR';
  if (nonEmpty.every(isDatetime)) return 'TIMESTAMP';
  if (nonEmpty.every(isDate)) return 'DATE';
  if (nonEmpty.every(isBoolean)) return 'BOOLEAN';
  if (nonEmpty.every(isInteger)) return 'INTEGER';
  if (nonEmpty.every(isNumeric)) return 'NUMERIC';
  return 'VARCHAR';
}

export function hasEmpties(values: string[]): boolean {
  return values.some((v) => v.trim() === '');
}
