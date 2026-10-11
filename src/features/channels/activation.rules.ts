const requiredChecks = [
  'bot_identity',
  'group',
  'membership',
  'privacy_mode',
  'webhook',
  'inbound',
];
export const VERIFICATION_LIFETIME_MS = 600000;

export function checksPass(checks: { key: string; status: string }[], required = requiredChecks) {
  return required.every((key) =>
    checks.some((check) => check.key === key && check.status === 'pass'),
  );
}

type Facts = {
  configVersion: number;
  credentialVersion: number;
  expectedConfigVersion: number;
  checkedConfigVersion: number | null;
  checkedCredentialVersion: number | null;
  checkedAt: number | null;
  expiresAt: number | null;
  now: number;
  status: string | null;
  connectionStatus: string;
  checks: { key: string; status: string }[];
};

function verificationExpired(facts: Facts) {
  return (
    facts.checkedConfigVersion !== facts.configVersion ||
    facts.checkedCredentialVersion !== facts.credentialVersion ||
    facts.checkedAt === null ||
    facts.expiresAt === null ||
    facts.expiresAt <= facts.now ||
    facts.checkedAt + VERIFICATION_LIFETIME_MS <= facts.now
  );
}

export function activationFailure(facts: Facts) {
  if (facts.expectedConfigVersion !== facts.configVersion) {
    return 'E-TG-VERSION-CONFLICT';
  }
  if (verificationExpired(facts)) {
    return 'E-TG-VERIFICATION-EXPIRED';
  }
  if (facts.status !== 'pass' || facts.connectionStatus !== 'ready' || !checksPass(facts.checks)) {
    return 'E-TG-READINESS-INCOMPLETE';
  }
  return null;
}
