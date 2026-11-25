import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import { Dialog } from './Dialog';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve(confirmed: boolean): void;
}

/**
 * Ask before a destructive or irreversible action. The question is a real keyboard dialog, not
 * the browser's blocking box, so it can carry the workspace's own words and styling.
 */
export function useConfirm(): {
  confirm(options: ConfirmOptions): Promise<boolean>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        const request: Pending = { ...options, resolve };
        pendingRef.current = request;
        setPending(request);
      }),
    [],
  );

  const settle = useCallback((confirmed: boolean) => {
    const request = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    request?.resolve(confirmed);
  }, []);

  useEffect(
    () => () => {
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    },
    [],
  );

  const dialog =
    pending === null ? null : (
      <Dialog open onClose={() => settle(false)} label={pending.title}>
        <Card title={pending.title}>
          {pending.message === undefined ? null : <p>{pending.message}</p>}
          <div className="product-dialog-actions">
            <Button variant="ghost" onClick={() => settle(false)}>
              {pending.cancelLabel ?? 'Go back'}
            </Button>
            <Button
              variant={pending.danger === true ? 'danger' : 'primary'}
              onClick={() => settle(true)}
            >
              {pending.confirmLabel}
            </Button>
          </div>
        </Card>
      </Dialog>
    );

  return { confirm, dialog };
}
