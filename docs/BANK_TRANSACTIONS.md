# BANK TRANSACTIONS

Bank transaction integration lets you import transactions and turn them into SplitPro expenses.

This feature was provided by @alexanderwassbjer, who is currently maintaining related issues.

## Providers

- **Teller** — free for up to 100 connections, US-focused, 5,000+ institutions. See https://teller.io/docs.
- **Plaid** — widely supported but more expensive. See https://plaid.com/docs/institutions/.
- GoCardless is deprecated and no longer accepts new signups.

Only one provider can be active at a time. The first configured provider wins (GoCardless > Plaid > Teller).

## Setup (Teller)

1. Create a Teller account at https://teller.io and obtain your `application_id`.
2. For development/production: download your mTLS certificate and key from the Teller Dashboard.
3. Add the Teller environment variables to your deployment.
4. Verify configuration from the account page in SplitPro.

See [CONFIGURATION](CONFIGURATION.md) for the exact variables.

## Setup (Plaid)

1. Create a Plaid account and obtain your `client_id` and `secret`.
2. Add the Plaid environment variables to your deployment.
3. Verify configuration from the account page in SplitPro.

See [CONFIGURATION](CONFIGURATION.md) for the exact variables.

## How to use

1. Open your account page and click “Connect to bank.”
2. When adding an expense (group or friend), open the “Transactions” tab.
3. Select transactions and submit them to create expenses.

## Notes

- Duplicate detection prevents importing the same transaction twice.
- Multi-add is supported for batch creation.

## Troubleshooting

- If the “Connect to bank” option does not appear, confirm your provider keys and environment.
- **Plaid**: Ensure `PLAID_COUNTRY_CODES` matches the institutions you want to connect.
- **Teller**: Ensure `TELLER_CERT_PATH` and `TELLER_KEY_PATH` are set for development/production environments.

## UI walkthrough video

- Bank transaction import: https://github.com/user-attachments/assets/ab853a09-0020-473d-860b-df16ce8b2c63
