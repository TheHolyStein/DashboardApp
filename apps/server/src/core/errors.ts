import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { DashError, HTTP_STATUS, type ErrorCode } from '@dash/contract';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function errorBody(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/** Maps any thrown value to `[httpStatus, ErrorDto]`. Unknown errors never leak their message. */
export function mapError(err: unknown): [number, ErrorBody] {
  if (err instanceof DashError) {
    return [HTTP_STATUS[err.code], errorBody(err.code, err.message, err.details)];
  }
  const fe = err as Partial<FastifyError> | null;
  if (fe?.validation) return [HTTP_STATUS.invalid, errorBody('invalid', 'Invalid request')];
  const status = typeof fe?.statusCode === 'number' ? fe.statusCode : 0;
  if (status >= 400 && status < 500) {
    // Fastify's own client errors carry safe, generic messages.
    const message = typeof fe?.message === 'string' ? fe.message : 'Invalid request';
    if (status === 404) return [404, errorBody('not_found', message)];
    if (status === 400) return [HTTP_STATUS.invalid, errorBody('invalid', message)];
    return [status, errorBody('invalid', message)];
  }
  return [500, errorBody('internal', 'Internal server error')];
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  const [status, body] = mapError(err);
  if (status >= 500) req.log.error({ err }, 'unhandled error');
  void reply.status(status).send(body);
}

export function notFoundBody(): ErrorBody {
  return errorBody('not_found', 'Not found');
}
