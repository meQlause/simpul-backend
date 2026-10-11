import { checksPass } from './activation.rules.js';

type ReadinessCheck = {
  key: string;
  status: 'pass' | 'fail' | 'pending';
  message: string;
  action: string | null;
};

const checks = [
  ['bot_identity', 'Verified bot matches the workspace connection'],
  ['group', 'Confirmed Telegram group or supergroup'],
  ['membership', 'No administrator rights required for ordinary message access'],
  ['privacy_mode', 'Disable privacy mode in BotFather; re-add the bot if needed'],
  ['webhook', 'Dedicated Simpul webhook; never overwrite another application'],
];

export function readinessChecks(providerChecks: ReadinessCheck[], inbound: boolean) {
  return [
    ...checks.map(
      ([key, message]) =>
        providerChecks.find((check) => check.key === key) ?? {
          key,
          status: 'pending' as const,
          message,
          action: message,
        },
    ),
    {
      key: 'inbound',
      status: inbound ? ('pass' as const) : ('pending' as const),
      message: 'Send a new non-command check message in the target group',
      action: inbound ? null : 'Send a new non-command check message in the target group',
    },
    {
      key: 'indicator',
      status: 'pending' as const,
      message: 'Installed only during the activation you approve',
      action: null,
    },
  ];
}

function verificationStatus(checks: ReadinessCheck[], ready: boolean) {
  if (ready) {
    return 'pass';
  }

  return checks.some((check) => check.status === 'fail') ? 'fail' : 'pending';
}

export function readinessState(checks: ReadinessCheck[], channelStatus: string) {
  const ready = checksPass(checks);
  const status = verificationStatus(checks, ready);
  let nextStatus = channelStatus;

  if (ready && channelStatus !== 'active') {
    nextStatus = 'verified';
  }

  if (status === 'fail') {
    nextStatus = 'needs_action';
  }

  return { ready, status, channelStatus: nextStatus };
}
