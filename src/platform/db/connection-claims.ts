import type { Pool } from 'pg';
import { scopedTransaction } from './scoped-transaction.js';
import { DomainError } from '../errors/domain-error.js';

const IN_USE = 'E-TG-BOT-IN-USE';

export function createAccountClaims(system: Pool) {
  return {
    async assertAccountAvailable(workspaceId: string, accountId: string) {
      const result = await system.query<{ available: boolean }>(
        'SELECT bot_account_available($1, $2) AS available',
        [workspaceId, accountId],
      );

      if (!result.rows[0]?.available) {
        throw new DomainError(IN_USE);
      }
    },
    async claimAccount(input: { workspaceId: string; connectionId: string; accountId: string }) {
      let claimed: boolean;

      try {
        claimed = await scopedTransaction(
          async () => system,
          input.workspaceId,
          async (tx) => {
            const result = await tx.query<{ claimed: boolean }>(
              'SELECT claim_own_bot_account($1, $2, $3) AS claimed',
              [input.workspaceId, input.connectionId, input.accountId],
            );

            return result.rows[0].claimed;
          },
        );
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === '23505') {
          throw new DomainError(IN_USE);
        }

        throw error;
      }

      return async () => {
        if (claimed) {
          await scopedTransaction(
            async () => system,
            input.workspaceId,
            (tx) =>
              tx.query(
                'DELETE FROM connection_routes WHERE workspace_id = $1 AND bot_connection_id = $2',
                [input.workspaceId, input.connectionId],
              ),
          );
        }
      };
    },
  };
}
