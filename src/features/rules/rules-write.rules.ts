export function gathersHistory(
  rule: { active: boolean; historyMode: string },
  isNew: boolean,
  changes: string[],
) {
  return (
    rule.active &&
    rule.historyMode === 'digest' &&
    (isNew || changes.some((key) => key !== 'active'))
  );
}
