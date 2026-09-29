import { Injectable } from '@nestjs/common';
import { AppError } from '../common/errors.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

@Injectable()
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  assertAllowed(key: string): void {
    const recent = this.recent(key);
    if (recent.length >= MAX_FAILURES) {
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Try again later.');
    }
  }

  recordFailure(key: string): void {
    const recent = this.recent(key);
    recent.push(Date.now());
    this.failures.set(key, recent);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = Date.now() - WINDOW_MS;
    return (this.failures.get(key) ?? []).filter((time) => time > cutoff);
  }
}
