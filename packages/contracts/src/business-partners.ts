import { z } from 'zod';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

export const PARTNER_TYPES = ['customer', 'supplier', 'lead'] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export const moneyAmount = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, 'Enter an amount with up to 4 decimal places');

export const contactInput = z.object({
  name: z.string().trim().min(1).max(120),
  position: optionalText(120),
  phone: optionalText(40),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .transform((value) => (value === '' ? null : value))
    .pipe(z.email().nullable())
    .nullable()
    .optional(),
  isDefault: z.boolean().default(false),
});

export const addressInput = z.object({
  addressType: z.enum(['bill_to', 'ship_to']),
  addressName: z.string().trim().min(1).max(60),
  street: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  zipCode: optionalText(20),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .transform((value) => (value === '' ? null : value))
    .pipe(z.string().regex(/^[A-Z]{2}$/).nullable())
    .nullable()
    .optional(),
  isDefault: z.boolean().default(false),
});

const partnerFields = {
  name: z.string().trim().min(1).max(200),
  foreignName: optionalText(200),
  groupId: z.uuid().nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  taxId: optionalText(40),
  phone: optionalText(40),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .transform((value) => (value === '' ? null : value))
    .pipe(z.email().nullable())
    .nullable()
    .optional(),
  website: optionalText(200),
  paymentTermsId: z.uuid().nullable().optional(),
  creditLimit: moneyAmount.default('0'),
  status: z.enum(['active', 'inactive']).default('active'),
  remarks: optionalText(2000),
  contacts: z.array(contactInput).max(50).default([]),
  addresses: z.array(addressInput).max(50).default([]),
};

export const createPartnerRequest = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$/, 'Use letters, digits, dot, dash or underscore (max 30)'),
  partnerType: z.enum(PARTNER_TYPES),
  ...partnerFields,
});
export type CreatePartnerRequest = z.infer<typeof createPartnerRequest>;

export const updatePartnerRequest = z.object({
  version: z.number().int().positive(),
  partnerType: z.enum(PARTNER_TYPES),
  ...partnerFields,
});
export type UpdatePartnerRequest = z.infer<typeof updatePartnerRequest>;

export const partnerListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  partnerType: z.enum(PARTNER_TYPES).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PartnerListQuery = z.infer<typeof partnerListQuery>;

export interface PartnerContact {
  id: string;
  lineNo: number;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  isDefault: boolean;
}

export interface PartnerAddress {
  id: string;
  lineNo: number;
  addressType: 'bill_to' | 'ship_to';
  addressName: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  isDefault: boolean;
}

export interface PartnerSummary {
  id: string;
  code: string;
  name: string;
  partnerType: PartnerType;
  groupName: string | null;
  phone: string | null;
  status: 'active' | 'inactive';
}

export interface BusinessPartner {
  id: string;
  code: string;
  name: string;
  foreignName: string | null;
  partnerType: PartnerType;
  groupId: string | null;
  currency: string;
  taxId: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  paymentTermsId: string | null;
  creditLimit: string;
  status: 'active' | 'inactive';
  remarks: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  contacts: PartnerContact[];
  addresses: PartnerAddress[];
}

export const createGroupRequest = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/),
  name: z.string().trim().min(1).max(120),
  partnerType: z.enum(['customer', 'supplier']),
});
export type CreateGroupRequest = z.infer<typeof createGroupRequest>;

export interface PartnerGroup {
  id: string;
  code: string;
  name: string;
  partnerType: 'customer' | 'supplier';
}

export const createPaymentTermsRequest = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/),
  name: z.string().trim().min(1).max(120),
  dueDays: z.number().int().min(0).max(3650),
});
export type CreatePaymentTermsRequest = z.infer<typeof createPaymentTermsRequest>;

export interface PaymentTerms {
  id: string;
  code: string;
  name: string;
  dueDays: number;
}
