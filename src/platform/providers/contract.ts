type VerifiedAccount = {
  providerAccountId: string;
  botUsername: string;
  botName: string;
  canJoinGroups: boolean;
  privacyModeOk: boolean;
};

export type CredentialProvider = {
  verifyCredential: (credential: string) => Promise<VerifiedAccount>;
};

export type SetupProvider = CredentialProvider & {
  registerWebhook: (
    connection: { credential: string },
    url: string,
    secret: string,
  ) => Promise<void>;
};

export type ReadinessCheck = {
  key: string;
  status: 'pass' | 'fail' | 'pending';
  message: string;
  action: string | null;
};

export type ConnectionRef = {
  credential: string;
  providerAccountId: string;
  webhookUrl: string;
};

export type ActivationProvider = SetupProvider & {
  describeChat: (
    connection: ConnectionRef,
    chatId: string,
  ) => Promise<{
    chatType: 'group' | 'supergroup';
    title: string;
  }>;
  checkReadiness: (connection: ConnectionRef, chatId: string) => Promise<ReadinessCheck[]>;
  send: (
    connection: ConnectionRef,
    message: { kind: 'indicator'; chatId: string; text: string },
  ) => Promise<{ providerMessageId: string }>;
};

type SetupEvent = {
  type: 'setup-command';
  code: string;
  chatId: string;
  title: string;
  chatType: 'group' | 'supergroup';
};
export type ReceiveProvider = {
  authenticate: (
    request: { headers: Record<string, string | string[] | undefined> },
    secret: string,
  ) => boolean;
  parse: (update: unknown) => SetupEvent | { type: 'ignore' };
};
