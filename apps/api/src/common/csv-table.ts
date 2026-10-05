import type { ImportRowError } from '@nec/contracts';
import { CsvSyntaxError, parseCsv } from './csv.js';

export interface ImportRow {
  row: number;
  fields: Record<string, string>;
}

export interface ImportErrors {
  errors: ImportRowError[];
  add(row: number | null, column: string | null, message: string): void;
}

export function importErrors(): ImportErrors {
  const errors: ImportRowError[] = [];
  return { errors, add: (row, column, message) => errors.push({ row, column, message }) };
}

export function validImportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function readCsvTable(csv: string, columns: readonly { name: string; required: boolean }[], maxRows: number, errors: ImportErrors): ImportRow[] {
  let records;
  try {
    records = parseCsv(csv);
  } catch (error) {
    if (error instanceof CsvSyntaxError) {
      errors.add(error.row, null, error.message);
      return [];
    }
    throw error;
  }
  const [header, ...data] = records;
  if (!header) {
    errors.add(null, null, 'The file is empty');
    return [];
  }
  const names = header.values.map((value) => {
    const trimmed = value.trim();
    return columns.find((column) => column.name.toLowerCase() === trimmed.toLowerCase())?.name ?? trimmed;
  });
  names.forEach((name, index) => {
    if (!columns.some((column) => column.name === name)) errors.add(header.row, name || `Column ${index + 1}`, `Unknown column "${name}"`);
    else if (names.indexOf(name) !== index) errors.add(header.row, name, `Column ${name} appears more than once`);
  });
  for (const column of columns) {
    if (column.required && !names.includes(column.name)) errors.add(header.row, column.name, `The required column ${column.name} is missing`);
  }
  if (data.length === 0) errors.add(null, null, 'The file has no data rows');
  if (data.length > maxRows) errors.add(null, null, `The file has ${data.length} data rows; the limit is ${maxRows}`);
  if (errors.errors.length > 0) return [];
  return data.map((record) => {
    if (record.values.slice(names.length).some((value) => value.trim() !== '')) errors.add(record.row, null, 'The row has more values than the header');
    const fields: Record<string, string> = {};
    names.forEach((name, index) => {
      fields[name] = (record.values[index] ?? '').trim();
    });
    for (const column of columns) {
      if (column.required && !fields[column.name]) errors.add(record.row, column.name, `${column.name} is required`);
    }
    return { row: record.row, fields };
  });
}
