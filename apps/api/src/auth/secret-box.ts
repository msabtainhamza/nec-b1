import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';

const PREFIX = 'v1:';

@Injectable()
export class SecretBox {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = config.MFA_ENCRYPTION_KEY
      ? Buffer.from(config.MFA_ENCRYPTION_KEY, 'base64')
      : Buffer.from(hkdfSync('sha256', config.JWT_ACCESS_SECRET, 'nec-erp', 'mfa-secret-encryption-v1', 32));
    if (this.key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes encoded as base64');
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
  }

  decrypt(value: string): string {
    if (!this.isEncrypted(value)) return value;
    const data = Buffer.from(value.slice(PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }
}
