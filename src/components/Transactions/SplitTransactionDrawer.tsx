import React, { useCallback, useState } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import { api } from '~/utils/api';
import { AppDrawer } from '~/components/ui/drawer';
import { EntityAvatar } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { ExternalLink } from 'lucide-react';

interface SplitTransactionDrawerProps {
  transaction: {
    id: string;
    amount: string;
    currency: string;
    description: string;
    date: Date;
    status: string;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Drawer for the quick "split this" flow from the Transactions inbox.
 * Shows the transaction details and a friend/group picker.
 *
 * Quick path: pick a friend or group → navigates to /add pre-filled.
 * The actual split confirmation (equal/exact/percentage) happens on the
 * existing AddExpensePage, keeping the split logic in one place.
 */
export const SplitTransactionDrawer: React.FC<SplitTransactionDrawerProps> = ({
  transaction,
  open,
  onOpenChange,
}) => {
  const { t } = useTranslation();
  const router = useRouter();
  const [filter, setFilter] = useState('');

  const friendsQuery = api.user.getFriends.useQuery(undefined, { enabled: open });
  const groupsQuery = api.group.getAllGroups.useQuery(undefined, { enabled: open });

  const filteredFriends = friendsQuery.data?.filter((f) =>
    (f.name ?? f.email)?.toLowerCase().includes(filter.toLowerCase()),
  );
  const filteredGroups = groupsQuery.data?.filter((g) =>
    g.group.name.toLowerCase().includes(filter.toLowerCase()),
  );

  const navigateToSplit = useCallback(
    (params: { friendId?: number; groupId?: number }) => {
      if (!transaction) return;

      const query: Record<string, string> = {
        transactionId: transaction.id,
        amount: transaction.amount.replace('-', ''),
        currency: transaction.currency,
        description: transaction.description,
        expenseDate: new Date(transaction.date).toISOString(),
      };

      if (params.friendId) {
        query.friendId = params.friendId.toString();
      }
      if (params.groupId) {
        query.groupId = params.groupId.toString();
      }

      onOpenChange(false);
      void router.push({ pathname: '/add', query });
    },
    [transaction, router, onOpenChange],
  );

  if (!transaction) return null;

  const isPending = transaction.status === 'pending';
  const absAmount = Math.abs(Number(transaction.amount));

  return (
    <AppDrawer
      trigger={<span aria-hidden="true" />}
      open={open}
      onOpenChange={onOpenChange}
      title="Split transaction"
      className="h-[70vh]"
    >
      {/* Transaction summary */}
      <div className="mb-4 rounded-lg border border-gray-800 p-3">
        <p className="text-sm font-medium text-gray-200">{transaction.description}</p>
        <p className="text-lg font-bold text-gray-100">
          {new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: transaction.currency,
          }).format(absAmount)}
        </p>
        <p className="text-xs text-gray-500">
          {new Intl.DateTimeFormat(undefined, {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          }).format(new Date(transaction.date))}
        </p>
      </div>

      {isPending && (
        <div className="mb-4 rounded-lg bg-yellow-500/10 px-3 py-2 text-sm text-yellow-500">
          This transaction is still pending. You can split it once it settles.
        </div>
      )}

      {!isPending && (
        <>
          {/* Search */}
          <input
            type="text"
            placeholder="Search friends or groups..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="bg-background mb-3 w-full rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-500 focus:border-cyan-500 focus:outline-none"
          />

          {/* Groups */}
          {filteredGroups && filteredGroups.length > 0 && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-medium text-gray-500 uppercase">Groups</p>
              <div className="flex flex-col gap-1">
                {filteredGroups.map(({ group }) => (
                  <button
                    key={group.id}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-gray-800/50"
                    onClick={() => navigateToSplit({ groupId: group.id })}
                  >
                    <EntityAvatar entity={group} size={32} />
                    <span className="text-sm text-gray-200">{group.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Friends */}
          {filteredFriends && filteredFriends.length > 0 && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-medium text-gray-500 uppercase">Friends</p>
              <div className="flex flex-col gap-1">
                {filteredFriends.map((friend) => (
                  <button
                    key={friend.id}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-gray-800/50"
                    onClick={() => navigateToSplit({ friendId: friend.id })}
                  >
                    <EntityAvatar entity={friend} size={32} />
                    <span className="text-sm text-gray-200">
                      {friend.name ?? friend.email}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Open full form link */}
          <button
            className="mt-2 flex items-center gap-2 text-xs text-gray-500 hover:text-gray-300"
            onClick={() => navigateToSplit({})}
          >
            <ExternalLink className="size-3" />
            Open full expense form
          </button>
        </>
      )}
    </AppDrawer>
  );
};
