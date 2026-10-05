import * as OTPAuth from 'otpauth';

export const TOTP_PERIOD_SECONDS = 30;

function totp(secret: string, label = 'NEC ERP', issuer = 'NEC ERP'): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ issuer, label, secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: TOTP_PERIOD_SECONDS });
}

export function validateTotp(secret: string, token: string): number | null {
  const delta = totp(secret).validate({ token, window: 1 });
  if (delta === null) return null;
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS) + delta;
}

export function newTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function totpUri(secret: string, account: string): string {
  return totp(secret, account).toString();
}

export function currentTotp(secret: string): string {
  return totp(secret).generate();
}
