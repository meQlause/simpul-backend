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

export function redactPii(body: string) {
  return body
    .replace(/(?<![\p{L}\p{N}-])\d(?:[ -]?\d){9,18}(?![\p{L}\p{N}])/gu, '[REDACTED]')
    .replace(
      /\b((?:rekening|rek\.?|bank account|account number)(?:\s*[:=]\s*|\s+))\d(?:[ -]?\d){5,19}(?!\d)/giu,
      '$1[REDACTED]',
    );
}
