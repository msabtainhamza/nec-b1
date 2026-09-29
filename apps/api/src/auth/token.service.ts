import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG, type AppConfig } from '../config.js';

export type TokenAudience = 'erp-app' | 'erp-platform';

export interface AccessClaims {
  subject: string;
  sessionId: string;
  tenantId: string | null;
  audience: TokenAudience;
}

const ISSUER = 'nec-erp-api';

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;
  readonly accessTtlSeconds: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
    this.accessTtlSeconds = config.JWT_ACCESS_TTL_SECONDS;
  }

  async sign(claims: AccessClaims): Promise<string> {
    const jwt = new SignJWT({ sid: claims.sessionId, ...(claims.tenantId ? { tid: claims.tenantId } : {}) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.subject)
      .setIssuer(ISSUER)
      .setAudience(claims.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`);
    return jwt.sign(this.key);
  }

  async verify(token: string, audience: TokenAudience): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience, algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        return null;
      }
      return {
        subject: payload.sub,
        sessionId: payload.sid,
        tenantId: typeof payload.tid === 'string' ? payload.tid : null,
        audience,
      };
    } catch {
      return null;
    }
  }
}
