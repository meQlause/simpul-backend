export type { CredentialProvider } from './contract.js';
export type { SetupProvider } from './contract.js';
export type { ReceiveProvider } from './contract.js';
export type { ActivationProvider, ReadinessCheck } from './contract.js';
export type {
  ProviderAdapter,
  Capabilities,
  Limits,
  OutboundMessage,
  SendResult,
} from './contract.js';
export { createTelegramProvider } from './telegram/index.js';
