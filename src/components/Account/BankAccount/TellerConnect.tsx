import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTellerConnect } from 'teller-connect-react';
import { api } from '~/utils/api';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import type { ButtonProps } from '~/components/ui/button';

type TellerEnvironment = 'sandbox' | 'development' | 'production';

const TELLER_ENVIRONMENTS = new Set<string>(['sandbox', 'development', 'production']);

function isTellerEnvironment(value: string): value is TellerEnvironment {
  return TELLER_ENVIRONMENTS.has(value);
}

function parseTellerEnvironment(value: string): TellerEnvironment {
  return isTellerEnvironment(value) ? value : 'sandbox';
}

interface TellerConnectProps {
  onSuccess?: () => void;
  children: React.ReactElement<ButtonProps>;
}

/**
 * Fetches Teller config (applicationId + environment) from the server via connectToBank,
 * then configures the Teller Connect widget.
 *
 * Unlike PlaidLink which receives a single link token via onConnect, Teller needs
 * both applicationId (authLink) and environment (institutionId) from the server response,
 * so this component calls the mutation directly.
 */
const useTellerConnectHook = (
  onTellerSuccess: (authorization: { accessToken: string }) => void,
  onTellerExit: () => void,
): { open: () => void; ready: boolean } => {
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<TellerEnvironment>('sandbox');
  const requestedRef = useRef(false);
  const connectToBank = api.bankTransactions.connectToBank.useMutation();

  useEffect(() => {
    const fetchConfig = async () => {
      const res = await connectToBank.mutateAsync();
      if (res?.authLink) {
        setApplicationId(res.authLink);
        setEnvironment(parseTellerEnvironment(res.institutionId));
      }
    };

    if (!applicationId && !requestedRef.current) {
      requestedRef.current = true;
      void fetchConfig();
    }
  }, [applicationId, connectToBank]);

  const { open, ready } = useTellerConnect({
    applicationId: applicationId ?? '',
    environment,
    products: ['transactions'],
    onSuccess: onTellerSuccess,
    onExit: onTellerExit,
  });

  return {
    open: open as () => void,
    ready: ready && Boolean(applicationId),
  };
};

export const TellerConnect: React.FC<TellerConnectProps> = ({ onSuccess, children }) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const exchangePublicToken = api.bankTransactions.exchangePublicToken.useMutation();

  const onTellerSuccess = useCallback(
    async (authorization: { accessToken: string }) => {
      setIsLoading(true);
      try {
        // Send the access token to the server for storage via the shared exchangePublicToken
        // Mutation. For Teller this just stores it directly, no server-side exchange needed.
        await exchangePublicToken.mutateAsync(authorization.accessToken);
        toast.success(t('bank_transactions.plaid.bank_connected_successfully'));
        onSuccess?.();
      } catch (error) {
        console.error('Error storing Teller access token:', error);
        toast.error(t('bank_transactions.plaid.bank_connection_failed'));
      } finally {
        setIsLoading(false);
      }
    },
    [exchangePublicToken, onSuccess, t],
  );

  const onTellerExit = useCallback(() => {
    // User dismissed Teller Connect without completing
  }, []);

  const { open, ready } = useTellerConnectHook(onTellerSuccess, onTellerExit);

  return React.cloneElement(children, {
    onClick: open,
    disabled: !ready || isLoading || (children.props as ButtonProps).disabled,
  } as Partial<ButtonProps>);
};
