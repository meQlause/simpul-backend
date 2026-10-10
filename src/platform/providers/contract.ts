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
