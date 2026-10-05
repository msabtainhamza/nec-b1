export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,99}\.csv$/;

export function validateCsvExport(name: unknown, content: unknown): { name: string; content: string } {
  if (typeof name !== 'string' || !FILE_NAME.test(name) || name.includes('..')) {
    throw new Error('Invalid export file name');
  }
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_EXPORT_BYTES) {
    throw new Error('Invalid export content');
  }
  return { name, content };
}

export function withCsvExtension(path: string): string {
  return path.toLowerCase().endsWith('.csv') ? path : `${path}.csv`;
}
