import { PgBoss } from 'pg-boss';
import type { Pool, PoolClient } from 'pg';

export async function createQueue(pool: Pool, scheduling = false, onError?: () => void) {
  const boss = new PgBoss({
    db: { executeSql: (text, values) => pool.query(text, values) },
    schedule: scheduling,
    supervise: false,
  });

  boss.on('error', () => {
    onError?.();
  });

  await boss.start();

  for (const name of [
    'ingest.coalesce',
    'ingest.media',
    'ingest.start',
    'ingest.retention',
    'understanding.triage',
    'understanding.resolve',
    'understanding.comprehend',
    'understanding.embed',
    'delivery.gate',
    'delivery.send',
    'delivery.question',
    'delivery.staleness',
    'delivery.digest',
    'scheduler.tick',
    'scheduler.retention',
    'database.probe',
    'metrics.snapshot',
    'work.lifecycle',
    'workspace.erase',
  ]) {
    await boss.createQueue(name, { retryLimit: 5, retryBackoff: true });
  }

  return boss;
}

// FR-TG-12: a private Start, carrying the invite code's hash and never the code.
export function publishStart(boss: PgBoss) {
  return (
    tx: PoolClient,
    payload: {
      workspaceId: string;
      connectionId: string;
      chatId: string;
      senderExternalId: string;
      senderHandle?: string;
      codeHash?: string;
    },
  ) =>
    boss.send('ingest.start', payload, {
      db: { executeSql: (text, values) => tx.query(text, values) },
    });
}

export function publishMedia(boss: PgBoss) {
  return (tx: PoolClient, payload: { workspaceId: string; messageId: string }) =>
    boss.send('ingest.media', payload, {
      db: { executeSql: (text, values) => tx.query(text, values) },
    });
}

export function publishComprehension(boss: PgBoss) {
  return (
    tx: PoolClient,
    payload: { workspaceId: string; unitId: string; threadId: string | null },
  ) =>
    boss.send('understanding.comprehend', payload, {
      db: { executeSql: (text, values) => tx.query(text, values) },
    });
}

export function publishNotification(boss: PgBoss) {
  return (
    tx: PoolClient,
    payload: { workspaceId: string; notificationId: string },
    heldUntil: Date,
  ) =>
    boss.send('delivery.send', payload, {
      startAfter: heldUntil,
      db: { executeSql: (text, values) => tx.query(text, values) },
    });
}

export function publishQuestion(boss: PgBoss) {
  return (tx: PoolClient, payload: { workspaceId: string; questionId: string }) =>
    boss.send('delivery.question', payload, {
      db: { executeSql: (text, values) => tx.query(text, values) },
    });
}

export function publishResolution(boss: PgBoss) {
  return (tx: PoolClient, payload: { workspaceId: string; unitId: string }) =>
    boss.send('understanding.resolve', payload, {
      db: { executeSql: (text, values) => tx.query(text, values) },
    });
}

export function publishEmbedding(boss: PgBoss) {
  return (tx: PoolClient, payload: { workspaceId: string; unitId: string }) =>
    boss.send('understanding.embed', payload, {
      db: { executeSql: (text, values) => tx.query(text, values) },
    });
}

export function publishMatching(boss: PgBoss) {
  return (tx: PoolClient, payload: { workspaceId: string; labelId: string }) =>
    boss.send('delivery.gate', payload, {
      db: { executeSql: (text, values) => tx.query(text, values) },
    });
}

export function publishCoalesce(boss: PgBoss, debounceSeconds = 12) {
  return (
    tx: PoolClient,
    payload: { workspaceId: string; channelId: string; senderExternalId: string },
  ) =>
    boss.send('ingest.coalesce', payload, {
      startAfter: debounceSeconds,
      db: { executeSql: (text, values) => tx.query(text, values) },
    });
}

export function publishUnit(boss: PgBoss) {
  return (tx: PoolClient, payload: { workspaceId: string; unitId: string }) =>
    boss.send('understanding.triage', payload, {
      db: { executeSql: (text, values) => tx.query(text, values) },
    });
}
