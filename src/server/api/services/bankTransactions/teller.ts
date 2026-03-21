import { readFileSync } from 'node:fs';
import { type RequestOptions, request } from 'node:https';
import { TRPCError } from '@trpc/server';
import { format, subDays } from 'date-fns';
import { env } from '~/env';
import { db } from '~/server/db';
import type { TransactionOutput, TransactionOutputItem } from '~/types/bank.types';

abstract class AbstractBankProvider {
  abstract getTransactions(userId: number, token?: string): Promise<TransactionOutput | undefined>;
  abstract connectToBank(
    id?: string,
    preferredLanguage?: string,
  ): Promise<{ institutionId: string; authLink: string } | undefined>;
  abstract getInstitutions(): Promise<{ id: string; name: string; logo: string }[]>;
  exchangePublicToken(
    _publicToken: string,
  ): Promise<{ accessToken: string; itemId: string } | undefined> {
    return Promise.resolve(undefined);
  }
}

const TELLER_CONSTANTS = {
  BASE_URL: 'https://api.teller.io',
  DEFAULT_INTERVAL_DAYS: 30,
  DATE_FORMAT: 'yyyy-MM-dd',
} as const;

const ERROR_MESSAGES = {
  FAILED_FETCH_CACHED: 'Failed to fetch cached transactions',
  FAILED_FETCH_TRANSACTIONS: 'Failed to fetch transactions',
  FAILED_FETCH_ACCOUNTS: 'Failed to fetch accounts',
  FAILED_CONNECT_BANK: 'Failed to connect to bank',
  MISSING_APPLICATION_ID: 'Teller application ID is not configured',
} as const;

export interface TellerAccount {
  id: string;
  enrollment_id: string;
  name: string;
  type: string;
  subtype: string;
  currency: string;
  last_four: string;
  status: string;
  institution: {
    id: string;
    name: string;
  };
}

export interface TellerTransaction {
  id: string;
  account_id: string;
  amount: string;
  date: string;
  description: string;
  status: 'posted' | 'pending';
  type: string;
  details: {
    processing_status: string;
    category: string;
    counterparty: {
      name: string;
      type: string;
    };
  };
}

export class TellerService extends AbstractBankProvider {
  private readonly tlsOptions: { cert: Buffer; key: Buffer } | undefined;

  constructor() {
    super();

    // MTLS is required for development/production environments, optional for sandbox
    if (env.TELLER_CERT_PATH && env.TELLER_KEY_PATH) {
      try {
        this.tlsOptions = {
          cert: readFileSync(env.TELLER_CERT_PATH),
          key: readFileSync(env.TELLER_KEY_PATH),
        };
      } catch (err) {
        throw new Error(
          `Failed to load Teller mTLS certificates (cert: ${env.TELLER_CERT_PATH}, key: ${env.TELLER_KEY_PATH}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
  }

  /**
   * Makes an HTTPS request to the Teller API using Node.js native https module.
   * We use native https instead of fetch because Next.js 15 uses undici for fetch,
   * which does not support the Node.js https.Agent for mTLS client certificates.
   */
  private tellerFetch<T>(path: string, accessToken?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, TELLER_CONSTANTS.BASE_URL);

      const options: RequestOptions = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken && {
            Authorization: `Basic ${Buffer.from(`${accessToken}:`).toString('base64')}`,
          }),
        },
        ...(this.tlsOptions && {
          cert: this.tlsOptions.cert,
          key: this.tlsOptions.key,
        }),
      };

      const req = request(options, (res) => {
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body) as T);
            } catch {
              reject(
                new TRPCError({
                  code: 'INTERNAL_SERVER_ERROR',
                  message: `Teller API returned invalid JSON: ${body.slice(0, 200)}`,
                }),
              );
            }
          } else {
            reject(
              new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: `Teller API error (${res.statusCode}): ${body.slice(0, 200)}`,
              }),
            );
          }
        });
      });

      req.on('error', (err) => {
        reject(
          new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Teller API request failed: ${err.message}`,
          }),
        );
      });

      req.end();
    });
  }

  async getTransactions(userId: number, accessToken?: string) {
    if (!accessToken) {
      return;
    }

    // Check cache first (24-hour TTL, same as Plaid/GoCardless)
    const cachedData = await db.cachedBankData.findUnique({
      where: { obapiProviderId: accessToken, userId },
    });

    if (cachedData) {
      if (!cachedData.data) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: ERROR_MESSAGES.FAILED_FETCH_CACHED,
        });
      }

      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      if (cachedData.lastFetched > twentyFourHoursAgo) {
        return JSON.parse(cachedData.data) as TransactionOutput;
      }
    }

    // Fetch all accounts to get their IDs and currencies
    const accounts = await this.tellerFetch<TellerAccount[]>('/accounts', accessToken);

    if (!accounts || accounts.length === 0) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: ERROR_MESSAGES.FAILED_FETCH_ACCOUNTS,
      });
    }

    const intervalInDays = env.TELLER_INTERVAL_IN_DAYS ?? TELLER_CONSTANTS.DEFAULT_INTERVAL_DAYS;
    const startDate = format(subDays(new Date(), intervalInDays), TELLER_CONSTANTS.DATE_FORMAT);
    const endDate = format(new Date(), TELLER_CONSTANTS.DATE_FORMAT);

    // Fetch transactions from all accounts in parallel and merge
    const accountTransactions = await Promise.all(
      accounts.map(async (account) => {
        const transactions = await this.tellerFetch<TellerTransaction[]>(
          `/accounts/${account.id}/transactions?start_date=${startDate}&end_date=${endDate}`,
          accessToken,
        );
        return { transactions: transactions ?? [], currency: account.currency };
      }),
    );

    const allBooked: TransactionOutputItem[] = [];
    const allPending: TransactionOutputItem[] = [];

    accountTransactions.forEach(({ transactions, currency }) => {
      transactions.forEach((txn) => {
        const formatted = this.formatTransaction(txn, currency);
        if (txn.status === 'pending') {
          allPending.push(formatted);
        } else {
          allBooked.push(formatted);
        }
      });
    });

    const formattedTransactions: TransactionOutput = {
      transactions: {
        booked: allBooked,
        pending: allPending,
      },
    };

    // Cache the results
    const data = {
      obapiProviderId: accessToken,
      data: JSON.stringify(formattedTransactions),
      lastFetched: new Date(),
      user: {
        connect: {
          id: userId,
        },
      },
    };

    await db.cachedBankData.upsert({
      where: { obapiProviderId: accessToken, userId },
      create: data,
      update: {
        data: JSON.stringify(formattedTransactions),
        lastFetched: new Date(),
      },
    });

    return formattedTransactions;
  }

  async connectToBank() {
    if (!env.TELLER_APPLICATION_ID) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: ERROR_MESSAGES.MISSING_APPLICATION_ID,
      });
    }

    // Return the application ID and environment so the frontend can open Teller Connect.
    // The authLink field carries the applicationId, and institutionId carries the environment
    // (following Split Pro's pattern of keeping provider config server-side via tRPC).
    return {
      institutionId: env.TELLER_ENVIRONMENT ?? 'sandbox',
      authLink: env.TELLER_APPLICATION_ID,
    };
  }

  /**
   * Teller gives the access token directly from Teller Connect's onSuccess callback —
   * no server-side exchange is needed. This method just passes the token through
   * in the shape the router expects so it can be stored on the user record.
   */
  async exchangePublicToken(accessToken: string) {
    return {
      accessToken,
      itemId: '',
    };
  }

  async getInstitutions() {
    // Teller Connect handles institution selection natively via its widget.
    // Unlike GoCardless, there's no need to fetch and display institutions separately.
    return [];
  }

  // Public API for the sync service to call directly, bypassing the AbstractBankProvider interface

  async fetchAccounts(accessToken: string): Promise<TellerAccount[]> {
    return this.tellerFetch<TellerAccount[]>('/accounts', accessToken);
  }

  async fetchTransactions(accessToken: string, accountId: string): Promise<TellerTransaction[]> {
    const intervalInDays = env.TELLER_INTERVAL_IN_DAYS ?? TELLER_CONSTANTS.DEFAULT_INTERVAL_DAYS;
    const startDate = format(subDays(new Date(), intervalInDays), TELLER_CONSTANTS.DATE_FORMAT);
    const endDate = format(new Date(), TELLER_CONSTANTS.DATE_FORMAT);

    return this.tellerFetch<TellerTransaction[]>(
      `/accounts/${accountId}/transactions?start_date=${startDate}&end_date=${endDate}`,
      accessToken,
    );
  }

  private formatTransaction(
    transaction: TellerTransaction,
    currency: string,
  ): TransactionOutputItem {
    return {
      transactionId: transaction.id,
      bookingDate: transaction.date,
      description: transaction.description || '?',
      transactionAmount: {
        amount: transaction.amount,
        currency,
      },
    };
  }
}
