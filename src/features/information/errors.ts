export class InformationError extends Error {
  constructor(
    public code:
      | "INVALID_INPUT"
      | "CONFLICT"
      | "AGENT_NOT_FOUND"
      | "DISABLED"
      | "AGENT_PAUSED"
      | "BUSY"
      | "NO_PENDING"
      | "NOT_FOUND"
      | "SHUTDOWN",
    message: string,
  ) {
    super(message);
  }
}
