export const SEARCH_LIMIT = 8;

export const SEARCH_MIN_SIMILARITY = 0.6;

export const SEARCH_EXTRA_CANDIDATES = 3;

const day = 86_400_000;
const defaultDays = 14;
const oldestDays = 60;

// Epoch milliseconds, so this rule never touches Date: the service turns the model's dates into instants.
// ponytail: whole-day edges come from the caller in UTC; a few hours of workspace offset is accepted for a 14-day search.
export function searchRange(unitAt: number, request: { from?: number | null; to?: number | null }) {
  const to = Math.min(unitAt, request.to ?? unitAt);
  const from = Math.max(unitAt - oldestDays * day, request.from ?? unitAt - defaultDays * day);

  return { from, to };
}

// Retrieved messages join the window's context, each message once (AC5, AC6).
export function mergeConversation(
  base: { messageId: string; text: string }[],
  retrieved: { messageId: string; text: string }[],
) {
  return [
    ...base,
    ...retrieved.filter((entry) => !base.some((item) => item.messageId === entry.messageId)),
  ];
}

// A unit is searched once: the stored query is what marks it (AC8).
export function searchAllowed(resolution: { searchQuery: string | null }) {
  return resolution.searchQuery === null;
}
