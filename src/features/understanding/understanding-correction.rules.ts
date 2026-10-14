export type CorrectionRefusal = { field: string; message?: string } | null;

// The refusals an admin's correction meets before anything is written. Shared by the draft (fast
// fail, no lock) and the write (re-checked under the unit's row lock).
export function correctionRefusal(
  facts: { startedThreadId: string | null; currentThreadId: string | null },
  input: { action: 'create' } | { action: 'attach'; target: { id: string; status: string } },
): CorrectionRefusal {
  if (input.action === 'create') {
    return facts.startedThreadId
      ? { field: 'action', message: 'This message already started this work.' }
      : null;
  }

  if (!['active', 'tentative'].includes(input.target.status)) {
    return { field: 'workDisplayId', message: 'Choose work that is still open.' };
  }

  return input.target.id === facts.currentThreadId ? { field: 'workDisplayId' } : null;
}
