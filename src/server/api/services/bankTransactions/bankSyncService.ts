import { type BankConnection } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { db } from '~/server/db';
import { TellerService, type TellerTransaction } from './teller';

// Reuse the TellerService for API calls. The sync service orchestrates
// fetching from the provider and persisting to BankTransaction.
const tellerService = new TellerService();

// In-memory lock to prevent concurrent syncs for the same user.
// Safe for single-instance deployments (self-hosted Synology NAS).
const activeSyncs = new Set<number>();

function isTodayUTC(date: Date | null | undefined): boolean {
  if (!date) return false;
  const now = new Date();
  return (
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  );
}

/**
 * Checks whether an auto sync should run for this connection.
 * Auto sync runs once per UTC calendar day on first page visit.
 */
export function canAutoSync(connection: Pick<BankConnection, 'lastAutoSync'>): boolean {
  return !isTodayUTC(connection.lastAutoSync);
}

/**
 * Checks whether a manual sync is available for this connection.
 * Users get one manual refresh per UTC calendar day.
 */
export function canManualSync(connection: Pick<BankConnection, 'lastManualSync'>): boolean {
  return !isTodayUTC(connection.lastManualSync);
}

function isValidAmount(amount: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(amount);
}

/**
 * Syncs transactions from Teller for a single BankConnection.
 * Fetches accounts + transactions from the Teller API, then upserts
 * into BankTransaction. Existing transactions that have been triaged
 * (split or dismissed) keep their state.
 */
export async function syncConnection(
  connection: BankConnection,
  syncType: 'auto' | 'manual',
): Promise<{ synced: number; newCount: number }> {
  if (connection.provider !== 'TELLER') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Unsupported provider: ${connection.provider}`,
    });
  }

  // Fetch accounts from Teller to get IDs and currencies
  const accounts = await tellerService.fetchAccounts(connection.accessToken);

  if (!accounts || accounts.length === 0) {
    console.warn(
      `[bank-sync] No accounts returned for connection ${connection.id.slice(0, 8)}`,
    );
    return { synced: 0, newCount: 0 };
  }

  // Update institution name if we don't have it yet (institution is the same across all accounts)
  if (!connection.institutionName && accounts[0]) {
    await db.bankConnection.update({
      where: { id: connection.id },
      data: {
        institutionName: accounts[0].institution.name,
      },
    });
  }

  // Fetch transactions from each account, tolerating individual account failures
  const accountTransactions = await Promise.all(
    accounts.map(async (account) => {
      try {
        const transactions = await tellerService.fetchTransactions(
          connection.accessToken,
          account.id,
        );
        return { transactions: transactions ?? [], currency: account.currency };
      } catch (err) {
        console.error(
          `[bank-sync] Failed to fetch transactions for account ${account.id.slice(0, 8)} ` +
            `(${account.name}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return { transactions: [] as TellerTransaction[], currency: account.currency };
      }
    }),
  );

  // Flatten and validate
  const allTransactions = accountTransactions.flatMap(({ transactions, currency }) =>
    transactions
      .filter((txn) => {
        if (!isValidAmount(txn.amount)) {
          console.warn(`[bank-sync] Skipping transaction ${txn.id} with invalid amount: ${txn.amount}`);
          return false;
        }
        return true;
      })
      .map((txn) => ({
        id: txn.id,
        bankConnectionId: connection.id,
        userId: connection.userId,
        amount: txn.amount,
        currency,
        description: txn.description || '?',
        date: new Date(txn.date),
        status: txn.status,
      })),
  );

  // Get existing transaction IDs to count genuinely new ones
  const existingIds = new Set(
    (
      await db.bankTransaction.findMany({
        where: {
          id: { in: allTransactions.map((t) => t.id) },
        },
        select: { id: true },
      })
    ).map((t) => t.id),
  );

  let newCount = 0;

  // Upsert transactions — preserve state/dismissReason for existing ones
  await Promise.all(
    allTransactions.map(async (txn) => {
      if (!existingIds.has(txn.id)) {
        newCount++;
      }

      await db.bankTransaction.upsert({
        where: { id: txn.id },
        create: {
          ...txn,
          state: 'unhandled',
        },
        update: {
          // Only update mutable fields from the provider.
          // Never overwrite state, dismissReason, or expenseId — those are user-managed.
          amount: txn.amount,
          description: txn.description,
          status: txn.status,
        },
      });
    }),
  );

  // Update sync timestamps
  const timestampField = syncType === 'auto' ? 'lastAutoSync' : 'lastManualSync';
  await db.bankConnection.update({
    where: { id: connection.id },
    data: {
      [timestampField]: new Date(),
      lastSyncedAt: new Date(),
    },
  });

  console.info(
    `[bank-sync] Connection ${connection.id.slice(0, 8)}: synced ${allTransactions.length} transactions (${newCount} new)`,
  );

  return { synced: allTransactions.length, newCount };
}

/**
 * Syncs all connections for a user. Used on Transactions page load.
 * Only syncs connections that are eligible (haven't synced today).
 * Uses an in-memory lock to prevent concurrent syncs for the same user
 * (safe for single-instance self-hosted deployments).
 */
export async function syncAllConnections(
  userId: number,
  syncType: 'auto' | 'manual',
): Promise<{ totalSynced: number; totalNew: number }> {
  // Prevent concurrent syncs for the same user (e.g., two tabs)
  if (activeSyncs.has(userId)) {
    return { totalSynced: 0, totalNew: 0 };
  }

  const connections = await db.bankConnection.findMany({
    where: { userId },
  });

  const eligibleConnections = connections.filter(
    syncType === 'auto' ? canAutoSync : canManualSync,
  );

  if (eligibleConnections.length === 0) {
    return { totalSynced: 0, totalNew: 0 };
  }

  activeSyncs.add(userId);

  try {
    let totalSynced = 0;
    let totalNew = 0;

    const results = await Promise.all(
      eligibleConnections.map(async (conn) => {
        try {
          return await syncConnection(conn, syncType);
        } catch (err) {
          console.error(
            `[bank-sync] Failed to sync connection ${conn.id.slice(0, 8)} ` +
              `(${conn.institutionName ?? conn.provider}): ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }
      }),
    );

    results.forEach((result) => {
      if (result) {
        totalSynced += result.synced;
        totalNew += result.newCount;
      }
    });

    return { totalSynced, totalNew };
  } finally {
    activeSyncs.delete(userId);
  }
}

/**
 * Migrates a user from the legacy obapiProviderId to a BankConnection.
 * Called lazily when a user with obapiProviderId visits the Transactions page
 * and doesn't yet have any BankConnection rows.
 *
 * Uses upsert on the (userId, accessToken) unique constraint to handle
 * concurrent calls safely (e.g., two tabs opening simultaneously).
 */
export async function migrateFromLegacy(userId: number): Promise<BankConnection | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { obapiProviderId: true },
  });

  if (!user?.obapiProviderId) {
    return null;
  }

  // Upsert handles the race condition — concurrent calls will either create or find.
  // The (userId, accessToken) unique constraint prevents duplicates at the DB level.
  const connection = await db.bankConnection.upsert({
    where: {
      userId_accessToken: {
        userId,
        accessToken: user.obapiProviderId,
      },
    },
    create: {
      userId,
      provider: 'TELLER',
      accessToken: user.obapiProviderId,
    },
    update: {},
  });

  // Clear the legacy field so this migration doesn't re-run on every page visit
  await db.user.update({
    where: { id: userId },
    data: { obapiProviderId: null },
  });

  console.info(`[bank-sync] Migrated legacy connection for user ${userId}`);

  return connection;
}
