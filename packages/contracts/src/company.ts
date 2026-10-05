import { z } from 'zod';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

export interface PostalAddress {
  street: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
}

export interface CompanyProfile extends PostalAddress {
  taxNumber: string | null;
  phone: string | null;
  email: string | null;
  invoiceFooter: string | null;
  version: number;
}

export const updateCompanyProfileRequest = z.object({
  street: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  zipCode: optionalText(20),
  country: optionalText(100),
  taxNumber: optionalText(50),
  phone: optionalText(50),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .transform((value) => (value === '' ? null : value))
    .pipe(z.email().nullable())
    .nullable()
    .optional(),
  invoiceFooter: optionalText(1000),
  version: z.number().int().min(0),
});
export type UpdateCompanyProfileRequest = z.infer<typeof updateCompanyProfileRequest>;
