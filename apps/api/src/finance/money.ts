const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);
const PATTERN = /^(-)?(\d+)(?:\.(\d{1,4}))?$/;

export type Money = bigint;

export function parseMoney(value: string): Money {
  const match = PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid amount: ${value}`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const units = BigInt(whole) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
  return sign ? -units : units;
}

export function formatMoney(value: Money): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / FACTOR;
  const fraction = (absolute % FACTOR).toString().padStart(SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function sumMoney(values: Iterable<Money>): Money {
  let total = 0n;
  for (const value of values) {
    total += value;
  }
  return total;
}

const PERCENT_BASE = 100n * FACTOR;
const COST_FACTOR = 1_000_000n;

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const result = (2n * n + d) / (2n * d);
  return negative ? -result : result;
}

export function multiplyMoney(quantity: Money, price: Money): Money {
  return divideRounded(quantity * price, FACTOR);
}

export function applyDiscount(price: Money, discountPercent: Money): Money {
  return divideRounded(price * (PERCENT_BASE - discountPercent), PERCENT_BASE);
}

export function averageCost(value: Money, quantity: Money): bigint {
  return quantity === 0n ? 0n : divideRounded(value * COST_FACTOR, quantity);
}

export function formatCost(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / COST_FACTOR}.${(absolute % COST_FACTOR).toString().padStart(6, '0')}`;
}

export function decimalPlaces(value: string): number {
  const fraction = value.trim().split('.')[1] ?? '';
  return fraction.replace(/0+$/, '').length;
}
