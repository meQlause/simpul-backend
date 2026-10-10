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
