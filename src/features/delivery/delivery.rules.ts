const minimumConfidence = 0.75;

export function renderActions(
  actions: { id: string; label: string }[],
  capabilities: { inlineActions: boolean },
): { actions?: { id: string; label: string }[]; text: string } {
  return capabilities.inlineActions
    ? { actions, text: '' }
    : { text: actions.map((action, index) => `${index + 1}. ${action.label}`).join('\n') };
}

export function quietHoursHold(facts: {
  localTime: string;
  quietStart: string;
  quietEnd: string;
  urgency: string;
}) {
  const { localTime, quietStart, quietEnd, urgency } = facts;
  const inside =
    quietStart < quietEnd
      ? localTime >= quietStart && localTime < quietEnd
      : localTime >= quietStart || localTime < quietEnd;

  return urgency !== 'high' && inside;
}

export function exceedsBudget(used: number, budget: number) {
  return used >= budget;
}

type RoutedRule = {
  ruleId: string;
  personId: string | null;
  destinationChannelId: string | null;
  urgency: string;
  priority: number;
};

export function mergeRecipientRules(matches: RoutedRule[]) {
  const recipients = new Map<string, RoutedRule>();

  for (const match of matches) {
    const key = match.personId ?? match.destinationChannelId!;
    const previous = recipients.get(key);

    if (!previous || (match.urgency === 'high' && previous.urgency !== 'high')) {
      recipients.set(key, match);
    }
  }

  return [...recipients.values()];
}

export function renderNotification(template: string, fields: Record<string, string>) {
  return template.replace(
    /\{\{([^{}]+)\}\}/gu,
    (placeholder, field: string) => fields[field.trim()] ?? placeholder,
  );
}

export function claimGate(
  label: {
    type?: string;
    tense: string;
    evidenceMessageIds: readonly string[];
    confidence: number;
  },
  thread: { status: string; historical: boolean },
) {
  return (
    label.confidence >= minimumConfidence &&
    label.evidenceMessageIds.length > 0 &&
    label.tense === 'sudah_terjadi' &&
    (thread.status === 'active' ||
      (thread.status === 'completed' && label.type === 'resolution')) &&
    !thread.historical
  );
}

// The candidates of a clarification, numbered, with "None of these" as the last choice (FR-UI-19).
export function questionActions(questionId: string, labels: readonly string[], numbered: boolean) {
  const choices = [...labels, 'None of these'];

  return choices.map((label, index) => ({
    id: `q:${questionId}:${index + 1}`,
    label: numbered ? `${index + 1} · ${label}` : label,
  }));
}

// A chosen number is a candidate thread, or 'none' for the last choice; anything else is no answer.
export function questionAnswer(choice: number, threadIds: readonly string[]) {
  if (choice >= 1 && choice <= threadIds.length) {
    return threadIds[choice - 1];
  }

  return choice === threadIds.length + 1 ? 'none' : undefined;
}
