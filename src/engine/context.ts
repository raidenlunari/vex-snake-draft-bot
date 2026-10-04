import { DraftError } from '../domain/errors.js';
import type { Draft, DraftConfig } from '../domain/types.js';
import type { Repositories } from '../db/repositories/index.js';

export interface DraftContext {
  draft: Draft;
  config: DraftConfig;
}

export function loadContext(repos: Repositories, draftId: number): DraftContext {
  const draft = repos.drafts.getById(draftId);
  if (!draft) throw new DraftError('DRAFT_NOT_FOUND', 'That draft no longer exists.');
  return { draft, config: repos.drafts.getConfig(draftId) };
}

export function requireStatus(ctx: DraftContext, allowed: Draft['status'][], what: string): void {
  if (!allowed.includes(ctx.draft.status)) {
    throw new DraftError('INVALID_STATE', `${what} is not possible while the draft is ${describeStatus(ctx.draft.status)}.`);
  }
}

export function describeStatus(status: Draft['status']): string {
  switch (status) {
    case 'setup':
      return 'in setup';
    case 'randomized':
      return 'randomized and waiting to start';
    case 'active':
      return 'active';
    case 'completed':
      return 'completed';
    case 'archived':
      return 'reset';
    default:
      return status;
  }
}
