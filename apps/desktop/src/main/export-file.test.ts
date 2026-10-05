import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_EXPORT_BYTES, validateCsvExport, withCsvExtension } from './export-file.js';

describe('csv export validation', () => {
  it('accepts plain csv file names and rejects paths, other types and oversized content', () => {
    assert.deepEqual(validateCsvExport('Vendor Aging 2026-06-30.csv', 'a,b'), { name: 'Vendor Aging 2026-06-30.csv', content: 'a,b' });
    for (const name of ['../secret.csv', 'C:\\Windows\\x.csv', 'report.exe', 'report.csv.exe', '.csv', 'a/b.csv', 42]) {
      assert.throws(() => validateCsvExport(name, 'x'), /file name/);
    }
    assert.throws(() => validateCsvExport('a.csv', { text: 'x' }), /content/);
    assert.throws(() => validateCsvExport('a.csv', 'x'.repeat(MAX_EXPORT_BYTES + 1)), /content/);
    assert.equal(withCsvExtension('C:\\out\\aging'), 'C:\\out\\aging.csv');
    assert.equal(withCsvExtension('C:\\out\\aging.CSV'), 'C:\\out\\aging.CSV');
  });
});
