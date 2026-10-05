import { z } from 'zod';

export const creditDecisionFields = {
  creditAcknowledged: z.boolean().optional(),
  creditOverrideReason: z.string().trim().min(1).max(500).optional(),
};
export type CreditDecision = { creditAcknowledged?: boolean | undefined; creditOverrideReason?: string | undefined };
export interface CreditExposure {
  balance: string;
  openOrders: string;
  uninvoicedDeliveries: string;
  total: string;
  creditLimit: string;
  remaining: string;
}
export const creditSettingsRequest = z.object({
  mode: z.enum(['disabled', 'warn', 'block']),
  version: z.number().int().min(0),
});
export type CreditSettings = z.infer<typeof creditSettingsRequest>;
export interface CreditLimitFailure {
  mode: 'warn' | 'block';
  exposure: CreditExposure;
  canOverride: boolean;
}
