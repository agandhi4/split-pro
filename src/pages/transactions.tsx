import Head from 'next/head';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import MainLayout from '~/components/Layout/MainLayout';
import { type NextPageWithUser } from '~/types';
import { api } from '~/utils/api';
import { useTranslationWithUtils } from '~/hooks/useTranslationWithUtils';
import { withI18nStaticProps } from '~/utils/i18n/server';
import { Button } from '~/components/ui/button';
import { Separator } from '~/components/ui/separator';
import { cn } from '~/lib/utils';
import { toast } from 'sonner';
import { Check, RefreshCw, Search, X } from 'lucide-react';
import { SplitTransactionDrawer } from '~/components/Transactions/SplitTransactionDrawer';

type TransactionState = 'unhandled' | 'split' | 'dismissed';

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

interface TransactionForSplit {
  id: string;
  amount: string;
  currency: string;
  description: string;
  date: Date;
  status: string;
}

const STATE_FILTERS: { label: string; value: TransactionState | undefined }[] = [
  { label: 'All', value: undefined },
  { label: 'Unhandled', value: 'unhandled' },
  { label: 'Split', value: 'split' },
  { label: 'Dismissed', value: 'dismissed' },
];

const TransactionsPage: NextPageWithUser = () => {
  const { t, i18n } = useTranslationWithUtils();
  const utils = api.useUtils();

  const [stateFilter, setStateFilter] = useState<TransactionState | undefined>('unhandled');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [splitDrawerOpen, setSplitDrawerOpen] = useState(false);
  const [splitTransaction, setSplitTransaction] = useState<TransactionForSplit | null>(null);

  // Mark transactions as viewed — deferred until lastViewed is loaded
  // so the "new" dots render correctly before the timestamp updates
  const markViewed = api.transactions.markViewed.useMutation();

  const debouncedSearch = useDebounce(searchQuery, 300);

  // Fetch transactions
  const transactionsQuery = api.transactions.list.useQuery({
    state: stateFilter,
    search: debouncedSearch || undefined,
    limit: 50,
  });

  // Fetch last viewed timestamp for "new" dot
  const lastViewedQuery = api.transactions.lastViewed.useQuery();

  // Update lastViewed only after the query succeeds, so dots render first
  const markViewedMutate = markViewed.mutate;
  useEffect(() => {
    if (lastViewedQuery.isSuccess) {
      markViewedMutate();
    }
  }, [lastViewedQuery.isSuccess, markViewedMutate]);

  // Sync status for the refresh button
  const syncStatusQuery = api.transactions.syncStatus.useQuery();
  const syncMutation = api.transactions.sync.useMutation({
    onSuccess: () => {
      void utils.transactions.list.invalidate();
      void utils.transactions.unhandledCount.invalidate();
      void utils.transactions.syncStatus.invalidate();
      toast.success('Transactions refreshed');
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  // Dismiss mutation
  const dismissMutation = api.transactions.dismiss.useMutation({
    onSuccess: (data, variables) => {
      void utils.transactions.list.invalidate();
      void utils.transactions.unhandledCount.invalidate();
      setSelectedIds(new Set());

      toast('Dismissed ' + data.dismissed + ' transactions', {
        action: {
          label: 'Undo',
          onClick: () => {
            undoDismissMutation.mutate({
              transactionIds: variables.transactionIds,
            });
          },
        },
      });
    },
  });

  const undoDismissMutation = api.transactions.undoDismiss.useMutation({
    onSuccess: () => {
      void utils.transactions.list.invalidate();
      void utils.transactions.unhandledCount.invalidate();
      toast.success('Transactions restored');
    },
  });

  const transactions = transactionsQuery.data?.items ?? [];
  const nextCursor = transactionsQuery.data?.nextCursor;
  const lastViewed = lastViewedQuery.data;

  const isNew = useCallback(
    (date: Date) => {
      if (!lastViewed) return false;
      return new Date(date) > new Date(lastViewed);
    },
    [lastViewed],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    const unhandledIds = transactions
      .filter((t) => t.state === 'unhandled')
      .map((t) => t.id);
    setSelectedIds(new Set(unhandledIds));
  }, [transactions]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const openSplitDrawer = useCallback(
    (txn: TransactionForSplit) => {
      if (txn.status === 'pending') {
        toast.error('This transaction is still pending. You can split it once it settles.');
        return;
      }
      setSplitTransaction(txn);
      setSplitDrawerOpen(true);
    },
    [],
  );

  const handleDismiss = useCallback(
    (reason?: 'handled_externally') => {
      if (selectedIds.size === 0) return;
      dismissMutation.mutate({
        transactionIds: Array.from(selectedIds),
        reason: reason ?? null,
      });
    },
    [selectedIds, dismissMutation],
  );

  // Group transactions by month for display
  const groupedTransactions = useMemo(() => {
    const groups: { key: string; label: string; items: typeof transactions }[] = [];
    let currentKey = '';

    transactions.forEach((txn) => {
      const date = new Date(txn.date);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      if (key !== currentKey) {
        currentKey = key;
        groups.push({
          key,
          label: new Intl.DateTimeFormat(i18n.language, {
            month: 'long',
            year: 'numeric',
          }).format(date),
          items: [],
        });
      }
      groups[groups.length - 1]!.items.push(txn);
    });

    return groups;
  }, [transactions, i18n.language]);

  const hasSelection = selectedIds.size > 0;

  const actions = useMemo(
    () => (
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Search className="size-5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => syncMutation.mutate()}
          disabled={!syncStatusQuery.data?.canManualSync || syncMutation.isPending}
        >
          <RefreshCw
            className={cn('size-5', syncMutation.isPending && 'animate-spin')}
          />
        </Button>
      </div>
    ),
    [syncMutation.mutate, syncMutation.isPending, syncStatusQuery.data?.canManualSync],
  );

  return (
    <>
      <Head>
        <title>{t('navigation.transactions') ?? 'Transactions'}</title>
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <MainLayout
        title={t('navigation.transactions') ?? 'Transactions'}
        actions={actions}
        loading={transactionsQuery.isPending && !transactionsQuery.data}
      >
        {/* Search bar */}
        {searchOpen && (
          <div className="mb-4 flex items-center gap-2">
            <input
              type="text"
              placeholder="Search transactions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-background flex-1 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-500 focus:border-cyan-500 focus:outline-none"
              autoFocus
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery('');
              }}
            >
              <X className="size-4" />
            </Button>
          </div>
        )}

        {/* Filter tabs */}
        <div className="mb-4 flex gap-2">
          {STATE_FILTERS.map((filter) => (
            <button
              key={filter.label}
              onClick={() => setStateFilter(filter.value)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                stateFilter === filter.value
                  ? 'bg-cyan-500/20 text-cyan-400'
                  : 'text-gray-500 hover:text-gray-300',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {/* Bulk actions bar */}
        {hasSelection && (
          <div className="bg-background sticky top-0 z-10 mb-4 flex items-center justify-between rounded-lg border border-gray-700 px-3 py-2">
            <span className="text-sm text-gray-400">
              {selectedIds.size} selected
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                Clear
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDismiss('handled_externally')}
              >
                Handled externally
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => handleDismiss()}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {/* Select all shortcut */}
        {!hasSelection && stateFilter === 'unhandled' && transactions.length > 0 && (
          <button
            onClick={selectAll}
            className="mb-3 text-xs text-gray-500 hover:text-gray-300"
          >
            Select all unhandled
          </button>
        )}

        {/* Sync status */}
        {syncStatusQuery.data?.lastSyncedAt && (
          <p className="mb-3 text-xs text-gray-600">
            Last synced{' '}
            {(() => {
              const diffMs = new Date(syncStatusQuery.data.lastSyncedAt).getTime() - Date.now();
              const diffMins = Math.round(diffMs / 60_000);
              const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
                Math.abs(diffMins) < 60
                  ? [diffMins, 'minute']
                  : [Math.round(diffMins / 60), 'hour'];
              return new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' }).format(
                value,
                unit,
              );
            })()}
          </p>
        )}

        {/* Transaction list */}
        {transactions.length === 0 && !transactionsQuery.isPending ? (
          <div className="mt-[30vh] text-center text-gray-400">
            {stateFilter
              ? `No ${stateFilter} transactions`
              : 'No transactions yet. Connect a bank account to get started.'}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {groupedTransactions.map((group) => (
              <React.Fragment key={group.key}>
                <div className="flex flex-row items-center gap-4 pt-2">
                  <div className="text-xs font-medium text-gray-700 uppercase">
                    {group.label}
                  </div>
                  <Separator className="flex-1 bg-gray-800" />
                </div>
                {group.items.map((txn) => (
                  <TransactionRow
                    key={txn.id}
                    txn={txn}
                    isNew={isNew(txn.date)}
                    isSelected={selectedIds.has(txn.id)}
                    onToggleSelect={toggleSelect}
                    onSplit={openSplitDrawer}
                    i18nLanguage={i18n.language}
                  />
                ))}
              </React.Fragment>
            ))}
            {nextCursor && (
              <p className="py-4 text-center text-xs text-gray-500">
                Showing first {transactions.length} transactions
              </p>
            )}
          </div>
        )}
        <SplitTransactionDrawer
          transaction={splitTransaction}
          open={splitDrawerOpen}
          onOpenChange={setSplitDrawerOpen}
        />
      </MainLayout>
    </>
  );
};

interface TransactionRowProps {
  txn: {
    id: string;
    amount: string;
    currency: string;
    description: string;
    date: Date;
    status: string;
    state: string;
    dismissReason: string | null;
    bankConnection: {
      institutionName: string | null;
      provider: string;
    };
    expense: {
      id: string;
      name: string;
      groupId: number | null;
    } | null;
  };
  isNew: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onSplit: (txn: TransactionForSplit) => void;
  i18nLanguage: string;
}

const TransactionRow: React.FC<TransactionRowProps> = React.memo(
  ({ txn, isNew, isSelected, onToggleSelect, onSplit, i18nLanguage }) => {
    const date = new Date(txn.date);
    const isPending = txn.status === 'pending';
    const isSplit = txn.state === 'split';
    const isDismissed = txn.state === 'dismissed';

    const formattedDate = new Intl.DateTimeFormat(i18nLanguage, {
      month: 'short',
      day: 'numeric',
    }).format(date);

    const formattedAmount = new Intl.NumberFormat(i18nLanguage, {
      style: 'currency',
      currency: txn.currency,
    }).format(Math.abs(Number(txn.amount)));

    return (
      <div
        className={cn(
          'flex items-center gap-3 rounded-lg px-2 py-2 transition-colors',
          isDismissed && 'opacity-50',
          isSelected && 'bg-cyan-500/10',
        )}
      >
        {/* Checkbox / state indicator — click to select */}
        <button
          className="flex w-5 shrink-0 items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            if (txn.state === 'unhandled') {
              onToggleSelect(txn.id);
            }
          }}
          aria-label={isSelected ? 'Deselect transaction' : 'Select transaction'}
        >
          {txn.state === 'unhandled' ? (
            <div
              className={cn(
                'h-4 w-4 rounded border transition-colors',
                isSelected
                  ? 'border-cyan-500 bg-cyan-500'
                  : 'border-gray-600',
              )}
            >
              {isSelected && <Check className="h-4 w-4 text-white" />}
            </div>
          ) : isSplit ? (
            <div className="h-2 w-2 rounded-full bg-emerald-500" />
          ) : (
            <div className="h-2 w-2 rounded-full bg-gray-600" />
          )}
        </button>

        {/* Content area — click to open split drawer */}
        <button
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => {
            if (txn.state === 'unhandled') {
              onSplit(txn);
            }
          }}
          aria-label={`Split ${txn.description}`}
        >
          {/* New dot */}
          {isNew && !isDismissed && (
            <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400" />
          )}

          {/* Date */}
          <span className="w-14 shrink-0 text-xs text-gray-500">{formattedDate}</span>

          {/* Description + source */}
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                'truncate text-sm',
                isDismissed ? 'text-gray-500' : 'text-gray-200',
              )}
            >
              {txn.description}
            </p>
            <div className="flex items-center gap-2">
              {txn.bankConnection.institutionName && (
                <span className="text-xs text-gray-600">
                  {txn.bankConnection.institutionName}
                </span>
              )}
              {isPending && (
                <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-500">
                  Pending
                </span>
              )}
              {isSplit && txn.expense && (
                <span className="text-xs text-emerald-500">
                  Split
                </span>
              )}
              {isDismissed && txn.dismissReason === 'handled_externally' && (
                <span className="text-xs text-gray-500">
                  Handled externally
                </span>
              )}
            </div>
          </div>

          {/* Amount */}
          <span
            className={cn(
              'shrink-0 text-sm font-medium',
              isDismissed ? 'text-gray-600' : 'text-gray-300',
            )}
          >
            {formattedAmount}
          </span>
        </button>
      </div>
    );
  },
);

TransactionRow.displayName = 'TransactionRow';

TransactionsPage.auth = true;

export const getStaticProps = withI18nStaticProps(['common']);

export default TransactionsPage;
