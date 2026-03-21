import { createTRPCRouter, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  canManualSync,
  migrateFromLegacy,
  syncAllConnections,
} from '../services/bankTransactions/bankSyncService';
import { whichBankConnectionConfigured } from '~/server/bankTransactionHelper';

const TransactionState = z.enum(['unhandled', 'split', 'dismissed']);
const DismissReason = z.enum(['handled_externally']).nullable();

export const transactionsRouter = createTRPCRouter({
  /**
   * List transactions for the current user with filtering.
   * Fires auto-sync in the background (non-blocking) if eligible.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          state: TransactionState.optional(),
          search: z.string().optional(),
          connectionId: z.string().optional(),
          cursor: z
            .object({
              date: z.string(),
              id: z.string(),
            })
            .optional(),
          limit: z.number().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.session.user.id;
      const { state, search, connectionId, cursor, limit = 50 } = input ?? {};

      // Migration must complete before sync (sync needs the BankConnection rows).
      // Both run in background to avoid blocking the list response.
      void (async () => {
        try {
          await migrateFromLegacy(userId);
          await syncAllConnections(userId, 'auto');
        } catch (err) {
          console.error(`[transactions] Background sync failed for user ${userId}:`, err);
        }
      })();

      // Composite cursor: (date DESC, id DESC) for stable pagination.
      // Teller dates are day-precision, so many transactions share the same timestamp.
      const cursorWhere = cursor
        ? {
            OR: [
              { date: { lt: new Date(cursor.date) } },
              { date: new Date(cursor.date), id: { lt: cursor.id } },
            ],
          }
        : {};

      const where = {
        userId,
        ...(state && { state }),
        ...(connectionId && { bankConnectionId: connectionId }),
        ...(search && {
          description: { contains: search, mode: 'insensitive' as const },
        }),
        ...cursorWhere,
      };

      const transactions = await ctx.db.bankTransaction.findMany({
        where,
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: {
          bankConnection: {
            select: {
              institutionName: true,
              provider: true,
            },
          },
          expense: {
            select: {
              id: true,
              name: true,
              groupId: true,
            },
          },
        },
      });

      const hasMore = transactions.length > limit;
      const items = hasMore ? transactions.slice(0, limit) : transactions;
      const lastItem = items[items.length - 1];
      const nextCursor = hasMore && lastItem
        ? { date: lastItem.date.toISOString(), id: lastItem.id }
        : undefined;

      return {
        items,
        nextCursor,
      };
    }),

  /**
   * Get unhandled transaction count for the nav badge.
   */
  unhandledCount: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.bankTransaction.count({
      where: { userId: ctx.session.user.id, state: 'unhandled' },
    });
  }),

  /**
   * Get the user's lastViewedTransactionsAt timestamp.
   */
  lastViewed: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { lastViewedTransactionsAt: true },
    });
    return user?.lastViewedTransactionsAt ?? null;
  }),

  /**
   * Update lastViewedTransactionsAt to now. Called when the page opens.
   */
  markViewed: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: { lastViewedTransactionsAt: new Date() },
    });
  }),

  /**
   * Manual sync — user-triggered refresh, limited to once per UTC day.
   */
  sync: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    const connections = await ctx.db.bankConnection.findMany({
      where: { userId },
      select: { lastManualSync: true },
    });

    const hasEligible = connections.some(canManualSync);
    if (!hasEligible) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Already refreshed today. Next refresh available tomorrow.',
      });
    }

    return syncAllConnections(userId, 'manual');
  }),

  /**
   * Get sync status for all connections (for the refresh button UI).
   */
  syncStatus: protectedProcedure.query(async ({ ctx }) => {
    const connections = await ctx.db.bankConnection.findMany({
      where: { userId: ctx.session.user.id },
      select: {
        lastSyncedAt: true,
        lastManualSync: true,
      },
    });

    return {
      canManualSync: connections.some(canManualSync),
      lastSyncedAt: connections.reduce<Date | null>((latest, conn) => {
        if (!conn.lastSyncedAt) return latest;
        if (!latest) return conn.lastSyncedAt;
        return conn.lastSyncedAt > latest ? conn.lastSyncedAt : latest;
      }, null),
    };
  }),

  /**
   * Dismiss one or more transactions.
   */
  dismiss: protectedProcedure
    .input(
      z.object({
        transactionIds: z.array(z.string()).min(1),
        reason: DismissReason.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { count } = await ctx.db.bankTransaction.updateMany({
        where: {
          id: { in: input.transactionIds },
          userId: ctx.session.user.id,
        },
        data: {
          state: 'dismissed',
          dismissReason: input.reason ?? null,
        },
      });
      return { dismissed: count };
    }),

  /**
   * Undo dismiss — restore transactions to unhandled state.
   */
  undoDismiss: protectedProcedure
    .input(
      z.object({
        transactionIds: z.array(z.string()).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { count } = await ctx.db.bankTransaction.updateMany({
        where: {
          id: { in: input.transactionIds },
          userId: ctx.session.user.id,
          state: 'dismissed',
        },
        data: {
          state: 'unhandled',
          dismissReason: null,
        },
      });
      return { restored: count };
    }),

  /**
   * List the user's bank connections (for the management drawer).
   */
  connections: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.bankConnection.findMany({
      where: { userId: ctx.session.user.id },
      select: {
        id: true,
        provider: true,
        institutionName: true,
        createdAt: true,
        lastSyncedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }),

  /**
   * Add a new bank connection. Called after Teller Connect's onSuccess.
   * Creates a BankConnection row only — does not write to the legacy
   * User.obapiProviderId field (that path is handled by migrateFromLegacy
   * for existing users, and new connections use BankConnection exclusively).
   */
  addConnection: protectedProcedure
    .input(
      z.object({
        accessToken: z.string().min(1),
        provider: z.string().default('TELLER'),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const connection = await ctx.db.bankConnection.upsert({
        where: {
          userId_accessToken: {
            userId: ctx.session.user.id,
            accessToken: input.accessToken,
          },
        },
        create: {
          userId: ctx.session.user.id,
          provider: input.provider,
          accessToken: input.accessToken,
        },
        update: {},
      });

      return connection;
    }),

  /**
   * Remove a bank connection and all its synced transactions.
   * CASCADE on BankTransaction handles the cleanup.
   */
  removeConnection: protectedProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const connection = await ctx.db.bankConnection.findFirst({
        where: {
          id: input.connectionId,
          userId: ctx.session.user.id,
        },
      });

      if (!connection) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
      }

      await ctx.db.bankConnection.delete({
        where: { id: connection.id },
      });

      return { deleted: true };
    }),

  /**
   * Check if bank connections are available (provider is configured).
   */
  isEnabled: protectedProcedure.query(() => {
    return { enabled: whichBankConnectionConfigured() === 'TELLER' };
  }),
});
