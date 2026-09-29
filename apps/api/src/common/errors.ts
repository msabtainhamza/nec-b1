import { ERROR_CODES } from '@nec/contracts';
import type { z } from 'zod';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthenticated = (message = 'Authentication is required') =>
  new AppError(401, ERROR_CODES.unauthenticated, message);

export const forbidden = (message = 'You do not have permission for this action') =>
  new AppError(403, ERROR_CODES.forbidden, message);

export const notFound = (message = 'The requested record was not found') =>
  new AppError(404, ERROR_CODES.notFound, message);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, ERROR_CODES.conflict, message, details);

export const versionConflict = () =>
  new AppError(409, ERROR_CODES.versionConflict, 'The record was changed by someone else. Reload and try again.');

export const limitExceeded = (resource: string, limit: number, used: number) =>
  new AppError(
    422,
    ERROR_CODES.limitExceeded,
    `Your plan allows ${limit} ${resource}; ${used} already in use.`,
    { resource, limit, used },
  );

export const subscriptionRestricted = (message = 'The company subscription does not allow this action') =>
  new AppError(403, ERROR_CODES.subscriptionRestricted, message);

export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      400,
      ERROR_CODES.validation,
      'The request contains invalid fields',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === '23505' && (constraint === undefined || pgError.constraint === constraint);
}
