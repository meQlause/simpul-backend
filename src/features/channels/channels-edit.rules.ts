export function channelEditState(
  before: { class: string; connectionStatus: string; monitored: boolean },
  audience?: string,
) {
  const clearReadiness = audience !== undefined && audience !== before.class;
  const statuses: Record<string, string> = { active: 'paused', verified: 'draft' };
  return {
    clearReadiness,
    connectionStatus: clearReadiness
      ? (statuses[before.connectionStatus] ?? before.connectionStatus)
      : before.connectionStatus,
    monitored: before.monitored && !clearReadiness,
  };
}
