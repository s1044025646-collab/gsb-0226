/**
 * 统一的业务错误定义。每个错误带稳定的机器可读 code，便于 API 调用方处理。
 */
export class AppError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    details === undefined ? undefined : (this.details = details);
  }
}

export function invalidParam(field: string, message: string): AppError {
  return new AppError("INVALID_PARAM", `参数 ${field} 非法: ${message}`, 400, { field });
}

export const ErrorCodes = {
  INVALID_PARAM: "INVALID_PARAM",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INTERNAL: "INTERNAL",
} as const;
