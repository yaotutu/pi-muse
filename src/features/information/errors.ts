export class InformationError extends Error {
  constructor(
    public code:
      | "INVALID_INPUT"
      | "CONFLICT"
      | "SESSION_NOT_FOUND"
      | "DISABLED"
      | "SESSION_PAUSED"
      | "BUSY"
      | "NO_PENDING"
      | "NOT_FOUND"
      | "SHUTDOWN",
    message: string,
  ) {
    super(message);
  }
}
