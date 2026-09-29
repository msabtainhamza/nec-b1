export const SUBSCRIPTION_STATES = ['trial', 'active', 'past_due', 'grace', 'suspended', 'cancelled'] as const;

export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export type AccessMode = 'full' | 'restricted_export' | 'none';

export interface SubscriptionAccessInput {
  state: SubscriptionState;
  retentionEndsAt: Date | null;
  now: Date;
}

export function subscriptionAccessMode(input: SubscriptionAccessInput): AccessMode {
  switch (input.state) {
    case 'trial':
    case 'active':
    case 'past_due':
    case 'grace':
      return 'full';
    case 'suspended':
    case 'cancelled':
      if (input.retentionEndsAt === null || input.retentionEndsAt > input.now) {
        return 'restricted_export';
      }
      return 'none';
  }
}

export const RESTRICTED_ACCESS_PERMISSION = 'admin.tenant.export';
