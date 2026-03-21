import React, { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '~/utils/api';
import { AppDrawer } from '~/components/ui/drawer';
import { Button } from '~/components/ui/button';
import { TellerConnect } from '~/components/Account/BankAccount/TellerConnect';

interface ConnectionManagerProps {
  trigger: React.ReactNode;
}

/**
 * Drawer for managing bank connections, accessible from the Transactions page.
 * Shows existing connections with disconnect option, and an "Add" button
 * that opens Teller Connect for new enrollments.
 */
export const ConnectionManager: React.FC<ConnectionManagerProps> = ({ trigger }) => {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);

  const connectionsQuery = api.transactions.connections.useQuery(undefined, {
    enabled: open,
  });

  const removeConnection = api.transactions.removeConnection.useMutation({
    onSuccess: () => {
      void utils.transactions.connections.invalidate();
      void utils.transactions.list.invalidate();
      void utils.transactions.unhandledCount.invalidate();
      toast.success('Connection removed');
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const addConnection = api.transactions.addConnection.useMutation({
    onSuccess: () => {
      void utils.transactions.connections.invalidate();
      void utils.transactions.list.invalidate();
      void utils.transactions.unhandledCount.invalidate();
      void utils.transactions.syncStatus.invalidate();
      toast.success('Bank account connected');
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const handleAccessToken = useCallback(
    async (accessToken: string) => {
      await addConnection.mutateAsync({ accessToken });
    },
    [addConnection],
  );

  const connections = connectionsQuery.data ?? [];

  return (
    <AppDrawer
      trigger={trigger}
      open={open}
      onOpenChange={setOpen}
      title="Manage Connections"
      className="h-[60vh]"
    >
      <div className="flex flex-col gap-3">
        {connections.length === 0 && (
          <p className="py-8 text-center text-sm text-gray-500">
            No bank accounts connected yet.
          </p>
        )}

        {connections.map((conn) => (
          <div
            key={conn.id}
            className="flex items-center justify-between rounded-lg border border-gray-800 px-3 py-3"
          >
            <div>
              <p className="text-sm font-medium text-gray-200">
                {conn.institutionName ?? conn.provider}
              </p>
              <p className="text-xs text-gray-500">
                Connected{' '}
                {new Intl.DateTimeFormat(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                }).format(new Date(conn.createdAt))}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingRemoveId(conn.id)}
              disabled={removeConnection.isPending}
            >
              <Trash2 className="size-4 text-red-400" />
            </Button>
          </div>
        ))}

        {/* Disconnect confirmation */}
        {pendingRemoveId && (
          <div className="rounded-lg border border-red-800/50 bg-red-500/10 p-3">
            <p className="mb-2 text-sm text-red-300">
              Disconnect this account? All synced transactions will be removed.
            </p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingRemoveId(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  removeConnection.mutate({ connectionId: pendingRemoveId });
                  setPendingRemoveId(null);
                }}
              >
                Disconnect
              </Button>
            </div>
          </div>
        )}

        {/* Add new connection via Teller Connect */}
        <TellerConnect onAccessToken={handleAccessToken}>
          <Button variant="outline" className="mt-2 w-full gap-2">
            <Plus className="size-4" />
            Add bank account
          </Button>
        </TellerConnect>
      </div>
    </AppDrawer>
  );
};
