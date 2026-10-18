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

export type Capabilities = {
  replyTo: boolean;
  edits: boolean;
  deletions: boolean;
  inlineActions: boolean;
  topics: boolean;
  mediaGroups: boolean;
  voiceNotes: boolean;
};

export type Limits = {
  callTimeoutMs: number;
  sendPerSecond: number;
  sendPerChatPerMinute: number;
};

export type OutboundMessage = {
  kind: 'notification' | 'question' | 'correction' | 'indicator' | 'notice';
  chatId: string;
  text: string;
  actions?: { id: string; label: string }[];
  replyToMessageId?: string;
};

// `unreachable`: the provider refused a person's private chat — no Start, or the bot was blocked (FR-TG-13).
export type SendResult =
  { providerMessageId: string } | { retryAfter: number } | { unreachable: true };

export type ActivationProvider = SetupProvider & {
  describeChat: (
    connection: ConnectionRef,
    chatId: string,
  ) => Promise<{
    chatType: 'group' | 'supergroup';
    title: string;
  }>;
  checkReadiness: (connection: ConnectionRef, chatId: string) => Promise<ReadinessCheck[]>;
  send: (connection: ConnectionRef, message: OutboundMessage) => Promise<SendResult>;
};

type SetupEvent = {
  type: 'setup-command';
  code: string;
  chatId: string;
  title: string;
  chatType: 'group' | 'supergroup';
};

// A private-chat Start, with the invite code when the person opened an invite link (FR-TG-12).
export type PersonStart = {
  type: 'person-start';
  updateId: string;
  chatId: string;
  senderExternalId: string;
  senderHandle?: string;
  code?: string;
};

export type InboundMessage = {
  type: 'message';
  updateId: string;
  chatId: string;
  messageId: string;
  senderExternalId: string;
  senderHandle?: string;
  body: string;
  mediaRef?: string;
  serverTs: number;
  setupProof: boolean;
};

export type ReceiveProvider = {
  authenticate: (
    request: { headers: Record<string, string | string[] | undefined> },
    secret: string,
  ) => boolean;
  parse: (update: unknown) =>
    | SetupEvent
    | InboundMessage
    | {
        type: 'action';
        updateId: string;
        chatId: string;
        senderExternalId: string;
        actionId: string;
        receiptId?: string;
      }
    | { type: 'setup-message'; chatId: string; sentAt: number }
    | PersonStart
    | { type: 'ignore' };
};

export type ProviderAdapter = ActivationProvider &
  ReceiveProvider & {
    readonly provider: string;
    readonly capabilities: Readonly<Capabilities>;
    readonly limits: Readonly<Limits>;
    acknowledgeAction?: (connection: { credential: string }, receiptId: string) => Promise<void>;
    downloadVoice?: (
      connection: ConnectionRef,
      mediaRef: string,
    ) => Promise<{ data: Uint8Array; mimeType: string }>;
  };
