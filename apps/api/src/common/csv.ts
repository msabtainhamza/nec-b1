export interface CsvRecord {
  row: number;
  values: string[];
}

export class CsvSyntaxError extends Error {
  constructor(
    readonly row: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseCsv(text: string): CsvRecord[] {
  const input = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let values: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let row = 1;
  let recordRow = 1;
  const endField = () => {
    values.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    if (values.some((value) => value.trim() !== '')) records.push({ row: recordRow, values });
    values = [];
    recordRow = row;
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') row += 1;
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (fieldStarted && field.trim() !== '') throw new CsvSyntaxError(row, `Row ${row}: a quote may only start a field`);
      field = '';
      quoted = true;
      fieldStarted = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row += 1;
      endRecord();
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (quoted) throw new CsvSyntaxError(recordRow, `Row ${recordRow}: a quoted field is not closed`);
  if (field !== '' || values.length > 0) endRecord();
  return records;
}
