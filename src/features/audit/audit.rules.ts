export function workDecision(facts: {
  displayId: string;
  action: 'completed' | 'cancelled' | 'outside_chat' | 'undo';
}) {
  return { title: facts.displayId + ' · ' + facts.action, detail: facts.action };
}
