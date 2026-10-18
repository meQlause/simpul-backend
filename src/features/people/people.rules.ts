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

const INVITE_DAYS = 7;
const DAY_MS = 86400000;

// Telegram stores a username without "@"; a connection may have saved it with one.
export function bareUsername(username: string) {
  return username.replace(/^@/u, '');
}

export function inviteLink(botUsername: string, code: string) {
  return `https://t.me/${bareUsername(botUsername)}?start=${code}`;
}

// Epoch milliseconds seven days after `now`.
export function inviteExpiry(now: Date) {
  return now.getTime() + INVITE_DAYS * DAY_MS;
}
