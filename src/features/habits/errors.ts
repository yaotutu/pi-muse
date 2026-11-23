export type HabitErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BUSY"
  | "LIMIT_EXCEEDED"
  | "SHUTDOWN";

export class HabitError extends Error {
  readonly code: HabitErrorCode;

  constructor(code: HabitErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "HabitError";
  }
}
