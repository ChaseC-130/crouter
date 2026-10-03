export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function safeError(error: unknown) {
  return error instanceof AppError
    ? error.message
    : "The local operation failed. Check project permissions and state files, then retry.";
}
