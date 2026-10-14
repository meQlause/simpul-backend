export function workDecision(facts: {
  displayId: string;
  action: 'completed' | 'cancelled' | 'outside_chat' | 'undo' | 'corrected';
}) {
  return { title: facts.displayId + ' · ' + facts.action, detail: facts.action };
}

export function digestDecision(facts: { recipientName: string; count: number }) {
  return {
    title: `Digest sent to ${facts.recipientName}`,
    detail: `${facts.count} pending updates delivered by email.`,
  };
}
