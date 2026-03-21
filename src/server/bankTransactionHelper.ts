import { env } from '~/env';

export type BankProviders = 'GOCARDLESS' | 'PLAID' | 'TELLER';

export const isBankConnectionConfigured = () => !!whichBankConnectionConfigured();

export const whichBankConnectionConfigured = (): BankProviders | null => {
  if (env.GOCARDLESS_SECRET_ID && env.GOCARDLESS_SECRET_KEY && env.GOCARDLESS_COUNTRY) {
    return 'GOCARDLESS';
  }
  if (env.PLAID_CLIENT_ID && env.PLAID_SECRET) {
    return 'PLAID';
  }
  if (env.TELLER_APPLICATION_ID) {
    return 'TELLER';
  }
  return null;
};
