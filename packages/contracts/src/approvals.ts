import { z } from 'zod';

export const APPROVAL_DOCUMENT_TYPES = ['sales_order', 'purchase_order'] as const;
export type ApprovalDocumentType = (typeof APPROVAL_DOCUMENT_TYPES)[number];

const amount = z.string().trim().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Enter an amount with up to 4 decimal places');

export const approvalTemplateRequest = z.object({
  name: z.string().trim().min(1).max(80),
  documentType: z.enum(APPROVAL_DOCUMENT_TYPES),
  minTotal: amount,
  approverRoleId: z.uuid(),
  requiredApprovals: z.number().int().min(1).max(10),
  active: z.boolean().default(true),
});
export type ApprovalTemplateRequest = z.infer<typeof approvalTemplateRequest>;

export const updateApprovalTemplateRequest = approvalTemplateRequest.extend({ version: z.number().int().positive() });
export type UpdateApprovalTemplateRequest = z.infer<typeof updateApprovalTemplateRequest>;

export interface ApprovalTemplate {
  id: string;
  name: string;
  documentType: ApprovalDocumentType;
  minTotal: string;
  approverRoleId: string;
  approverRoleName: string;
  requiredApprovals: number;
  active: boolean;
  version: number;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed';

export interface ApprovalDecision {
  approverName: string;
  decision: 'approved' | 'rejected';
  remarks: string | null;
  decidedAt: string;
}

export interface ApprovalRequestSummary {
  id: string;
  documentType: ApprovalDocumentType;
  templateName: string;
  originatorId: string;
  originatorName: string;
  partnerCode: string;
  partnerName: string;
  total: string;
  status: ApprovalStatus;
  approvals: number;
  requiredApprovals: number;
  canDecide: boolean;
  documentId: string | null;
  documentNumber: string | null;
  createdAt: string;
  version: number;
  decisions: ApprovalDecision[];
}

export interface ApprovalSubmitted {
  approvalRequired: true;
  request: ApprovalRequestSummary;
}

export const approvalListQuery = z.object({
  scope: z.enum(['mine', 'to_decide', 'all']).default('all'),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'completed']).optional(),
});
export type ApprovalListQuery = z.infer<typeof approvalListQuery>;

export const approvalDecisionRequest = z.object({
  decision: z.enum(['approved', 'rejected']),
  remarks: z.string().trim().max(500).optional(),
  version: z.number().int().positive(),
});
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequest>;

export const completeApprovalRequest = z.object({
  creditAcknowledged: z.boolean().optional(),
  creditOverrideReason: z.string().trim().min(1).max(500).optional(),
});
export type CompleteApprovalRequest = z.infer<typeof completeApprovalRequest>;
