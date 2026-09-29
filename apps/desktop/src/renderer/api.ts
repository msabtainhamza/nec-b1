import type { ApiErrorBody } from '@nec/contracts';
import type { ApiResult } from './erp';

export function errorMessage(result: ApiResult): string {
  const body = result.body as Partial<ApiErrorBody> | null;
  if (result.status === 0) {
    return 'The server could not be reached. Your input has been kept; try again when the connection returns.';
  }
  return body?.error?.message ?? `The request failed (${result.status}).`;
}

export function fieldErrors(result: ApiResult): Record<string, string> {
  const details = (result.body as Partial<ApiErrorBody> | null)?.error?.details;
  if (!Array.isArray(details)) {
    return {};
  }
  return Object.fromEntries(
    details
      .filter((item): item is { path: string; message: string } => typeof item?.path === 'string')
      .map((item) => [item.path, item.message]),
  );
}
