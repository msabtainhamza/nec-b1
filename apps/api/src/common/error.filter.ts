import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ERROR_CODES, type ApiErrorBody } from '@nec/contracts';
import type { Request, Response } from 'express';
import { AppError } from './errors.js';
import type { RequestWithContext } from './request-context.js';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & RequestWithContext>();
    const response = http.getResponse<Response>();
    const correlationId = request.correlationId;

    let status = 500;
    let body: ApiErrorBody['error'] = {
      code: ERROR_CODES.internal,
      message: 'An unexpected error occurred',
      correlationId,
    };

    if (exception instanceof AppError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message, details: exception.details, correlationId };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = {
        code: status === 404 ? ERROR_CODES.notFound : status === 400 ? ERROR_CODES.validation : ERROR_CODES.internal,
        message: status === 404 ? 'The requested resource was not found' : exception.message,
        correlationId,
      };
    } else {
      this.logger.error(
        JSON.stringify({
          correlationId,
          tenantId: request.principal?.tenantId ?? null,
          error: exception instanceof Error ? exception.message : String(exception),
          stack: exception instanceof Error ? exception.stack : undefined,
        }),
      );
    }

    response.status(status).json({ error: body } satisfies ApiErrorBody);
  }
}
