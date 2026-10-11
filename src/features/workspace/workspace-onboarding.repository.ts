import type { PoolClient } from 'pg';

export async function lockOnboarding(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{ onboardingCompletedAt: Date | null }>(
    'SELECT onboarding_completed_at AS "onboardingCompletedAt" FROM workspaces WHERE id = $1 FOR UPDATE',
    [workspaceId],
  );

  return result.rows[0];
}

export async function stampOnboarding(tx: PoolClient, workspaceId: string, now: Date) {
  const result = await tx.query<{ onboardingCompletedAt: Date }>(
    'UPDATE workspaces SET onboarding_completed_at = $2 WHERE id = $1 RETURNING onboarding_completed_at AS "onboardingCompletedAt"',
    [workspaceId, now],
  );

  return result.rows[0];
}
