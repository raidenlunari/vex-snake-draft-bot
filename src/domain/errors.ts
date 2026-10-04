/**
 * Domain error carrying a stable machine-readable code and a user-facing message.
 * The Discord layer renders `message` verbatim (prefixed with an emoji), so messages
 * must be written for end users.
 */
export type DraftErrorCode =
  | 'NO_DRAFT'
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_EXISTS'
  | 'INVALID_STATE'
  | 'INVALID_CONFIG'
  | 'CONFIG_LOCKED'
  | 'NOT_PARTICIPANT'
  | 'NOT_YOUR_TURN'
  | 'TEAM_NOT_FOUND'
  | 'TEAM_UNAVAILABLE'
  | 'TEAM_REMOVED'
  | 'TEAM_EXISTS'
  | 'PARTICIPANT_NOT_FOUND'
  | 'PARTICIPANT_EXISTS'
  | 'PICK_NOT_FOUND'
  | 'ASSET_NOT_FOUND'
  | 'PREPICK_ERROR'
  | 'TRADE_ERROR'
  | 'TRADE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'STALE'
  | 'VALIDATION';

export class DraftError extends Error {
  public readonly code: DraftErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: DraftErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DraftError';
    this.code = code;
    this.details = details;
  }
}

export function isDraftError(err: unknown): err is DraftError {
  return err instanceof DraftError;
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invariant violated: ${message}`);
  }
}
