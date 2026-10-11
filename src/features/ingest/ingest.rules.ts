export function burstGroups<Message extends { serverTs: number }>(
  messages: Message[],
  debounceMs: number,
) {
  const groups: Message[][] = [];

  for (const message of messages) {
    const last = groups.at(-1);
    const previous = last?.at(-1);

    if (!previous || message.serverTs - previous.serverTs > debounceMs) {
      groups.push([message]);
    } else {
      last?.push(message);
    }
  }

  return groups;
}
