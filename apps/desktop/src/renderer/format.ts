export function formatAmount(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const trimmed = fraction.replace(/0+$/, '').padEnd(2, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${trimmed}`;
}

export function toMinor(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value.trim().replace(/,/g, ''));
  if (!match) {
    return null;
  }
  return BigInt(match[1] ?? '0') * 10000n + BigInt((match[2] ?? '').padEnd(4, '0'));
}

export function fromMinor(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / 10000n}.${(absolute % 10000n).toString().padStart(4, '0')}`;
}

export function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
