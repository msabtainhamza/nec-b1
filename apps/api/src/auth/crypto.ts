import { createHash, randomBytes } from 'node:crypto';
import { hash, verify, type Options } from '@node-rs/argon2';

const ARGON2ID = 2;
const ARGON_OPTIONS: Options = { algorithm: ARGON2ID as Options['algorithm'], memoryCost: 19456, timeCost: 2, parallelism: 1 };

let dummyHash: Promise<string> | null = null;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(passwordHash: string | null, password: string): Promise<boolean> {
  if (passwordHash === null) {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return verify(passwordHash, password).catch(() => false);
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
