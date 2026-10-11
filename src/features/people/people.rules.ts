type Person = { id: string; active: boolean; availability: 'available' | 'leave' };
type Candidates = {
  holder: Person | null;
  backup: Person | null;
  supervisor: Person | null;
  admin: Person | null;
};

export function resolveRecipient(candidates: Candidates, originChannelId: string) {
  const order = ['holder', 'backup', 'supervisor', 'admin'] as const;

  for (const via of order) {
    const person = candidates[via];

    if (person?.active && person.availability === 'available') {
      return { kind: 'person', personId: person.id, via };
    }
  }

  return { kind: 'channel', channelId: originChannelId };
}

export function invalidPatchFields(
  personId: string,
  hasRole: boolean,
  input: { managerId?: string; backupPersonId?: string; roleName?: string },
  activeIds: readonly string[],
) {
  const targets = ['managerId', 'backupPersonId'] as const;
  const invalid: string[] = targets.filter(
    (field) =>
      input[field] !== undefined &&
      (input[field] === personId || !activeIds.includes(input[field])),
  );

  if (!hasRole) {
    invalid.push(
      ...(['roleName', 'backupPersonId'] as const).filter((field) => input[field] !== undefined),
    );
  }

  return [...new Set(invalid)];
}
