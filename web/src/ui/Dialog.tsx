import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface DialogProps {
  open: boolean;
  onClose(): void;
  /** The dialog's accessible name. Use `labelledBy` instead when its own heading names it. */
  label?: string;
  labelledBy?: string;
  role?: 'dialog' | 'alertdialog';
  /** While busy, Escape cannot close the dialog and the work already under way is not interrupted. */
  busy?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * One keyboard-complete dialog: it takes focus when it opens, keeps Tab inside, closes on Escape,
 * and gives focus back to the control that opened it.
 */
export function Dialog({
  open,
  onClose,
  label,
  labelledBy,
  role = 'dialog',
  busy = false,
  children,
  className,
}: DialogProps) {
  const card = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = card.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    if (node !== null && !node.contains(document.activeElement)) {
      (first ?? node).focus();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        if (!busyRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== 'Tab' || node === null) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (item) => !item.closest('[hidden]'),
      );
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;
      if (active === null || !node.contains(active)) {
        event.preventDefault();
        firstItem.focus();
        return;
      }
      if (event.shiftKey) {
        if (active === firstItem || active === node) {
          event.preventDefault();
          lastItem.focus();
        }
        return;
      }
      if (active === lastItem || active === node) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const target = returnTo.current;
      if (target?.isConnected === true) target.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="product-dialog-backdrop">
      <div
        ref={card}
        className={`product-dialog ${className ?? ''}`.trim()}
        role={role}
        aria-modal="true"
        {...(label === undefined ? {} : { 'aria-label': label })}
        {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
