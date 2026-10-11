const minimumConfidence = 0.75;

export function exceedsBudget(used: number, budget: number) {
  return used >= budget;
}

type RoutedRule = { ruleId: string; personId: string; urgency: string; priority: number };

export function mergeRecipientRules(matches: RoutedRule[]) {
  const recipients = new Map<string, RoutedRule>();

  for (const match of matches) {
    const previous = recipients.get(match.personId);

    if (!previous || (match.urgency === 'high' && previous.urgency !== 'high')) {
      recipients.set(match.personId, match);
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
  label: { tense: string; evidenceMessageIds: readonly string[]; confidence: number },
  thread: { status: string; historical: boolean },
) {
  return (
    label.confidence >= minimumConfidence &&
    label.evidenceMessageIds.length > 0 &&
    label.tense === 'sudah_terjadi' &&
    thread.status === 'active' &&
    !thread.historical
  );
}
