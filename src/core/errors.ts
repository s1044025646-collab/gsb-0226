import type { IssueCode } from './types.js';

export class ValidationError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: IssueCode | 'INVALID_NAME' | 'NOT_FOUND' | 'BAD_REQUEST' | 'VALIDATION_FAILED', message: string, details?: unknown) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
