const millisecondsPerHour = 3600000;
const escalationDelayHours = 72;

export function stalenessStage(input: {
  now: number;
  lastActivityAt: number;
  thresholdHours: number;
  reminderCreatedAt: number | null;
  reminderSentAt: number | null;
  escalations: number;
  escalationLimit: number;
}): 'reminder' | 'escalation' | null {
  if (input.now - input.lastActivityAt <= input.thresholdHours * millisecondsPerHour) {
    return null;
  }

  if (input.reminderCreatedAt === null || input.reminderCreatedAt < input.lastActivityAt) {
    return 'reminder';
  }

  if (input.reminderSentAt === null || input.escalations >= Math.min(1, input.escalationLimit)) {
    return null;
  }

  if (input.now - input.reminderSentAt >= escalationDelayHours * millisecondsPerHour) {
    return 'escalation';
  }

  return null;
}
