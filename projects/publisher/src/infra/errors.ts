export enum ExitCode {
  Success = 0,
  InvalidConfiguration = 2,
  AuthenticationExpired = 3,
  DayOutOfRange = 4,
  SafetyConflict = 5,
  DraftSelectionFailed = 6,
  BrowserWorkflowFailed = 7,
  VerificationFailed = 8,
  UnexpectedFailure = 9,
  GitSynchronizationFailed = 10,
}

export class AppError extends Error {
  public constructor(
    message: string,
    public readonly exitCode: ExitCode,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function exitCodeFor(error: unknown): ExitCode {
  return error instanceof AppError ? error.exitCode : ExitCode.UnexpectedFailure;
}

export function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      exitCode: error.exitCode,
      ...error.details,
    };
  }

  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }

  return { errorMessage: String(error) };
}
