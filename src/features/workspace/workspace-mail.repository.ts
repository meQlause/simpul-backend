import type { PoolClient } from 'pg';
import type { parseMail } from './workspace-mail.schema.js';

type MailRow = {
  id: string;
  host: string;
  port: number;
  username: string;
  fromAddress: string;
  passwordSecretRef: string;
  verifiedAt: Date | null;
};

export async function selectMail(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<MailRow>(
    `SELECT id, host, port, username, from_address AS "fromAddress",
    password_secret_ref AS "passwordSecretRef", verified_at AS "verifiedAt"
    FROM mail_connections WHERE workspace_id = $1`,
    [workspaceId],
  );

  return result.rows[0];
}

export async function saveMailRow(
  tx: PoolClient,
  workspaceId: string,
  input: ReturnType<typeof parseMail> & { secretRef: string; verifiedAt: Date },
) {
  await tx.query(
    `INSERT INTO mail_connections (workspace_id, host, port, username, from_address, password_secret_ref, verified_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (workspace_id) DO UPDATE SET host = EXCLUDED.host,
    port = EXCLUDED.port, username = EXCLUDED.username, from_address = EXCLUDED.from_address,
    password_secret_ref = EXCLUDED.password_secret_ref, verified_at = EXCLUDED.verified_at`,
    [
      workspaceId,
      input.host,
      input.port,
      input.username,
      input.fromAddress,
      input.secretRef,
      input.verifiedAt,
    ],
  );
}

export async function pendingDigestItems(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM (
      SELECT n.id FROM notifications n JOIN people p ON p.workspace_id = $1 AND p.id = n.recipient_person_id
      LEFT JOIN labels l ON l.workspace_id = $1 AND l.id = n.label_id
      LEFT JOIN rules r ON r.workspace_id = $1 AND r.id = n.rule_id
      WHERE n.workspace_id = $1 AND (p.level = 'executive' OR n.digest_id IS NOT NULL)
        AND n.sent_at IS NULL AND n.cancelled_at IS NULL AND l.retracted_at IS NULL AND coalesce(r.active, true)
      UNION ALL SELECT item.label_id FROM digest_items item JOIN digests d
        ON d.workspace_id = $1 AND d.id = item.digest_id AND d.sent_at IS NULL
      JOIN labels l ON l.workspace_id = $1 AND l.id = item.label_id AND l.retracted_at IS NULL
      JOIN rules r ON r.workspace_id = $1 AND r.id = item.rule_id AND r.active
      WHERE item.workspace_id = $1
    ) pending`,
    [workspaceId],
  );

  return result.rows[0].count;
}

export async function lockMailConfiguration(tx: PoolClient, workspaceId: string) {
  await tx.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
}
