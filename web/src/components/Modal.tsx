import { useEffect, useId, useRef, type ReactNode } from 'react';
import { pushModal, removeModal } from '../state/modal-stack';
import { CloseIcon } from './icons';
import { cx } from './utils';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Buttons row at the bottom. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Escape / backdrop click close the modal (default true). */
  dismissible?: boolean;
}

/** Escape on a non-dismissible modal: stop it before it becomes a close request. Exported for tests. */
export function modalKeyDown(e: { key: string; preventDefault(): void }, dismissible: boolean): void {
  if (e.key === 'Escape' && !dismissible) e.preventDefault();
}

/**
 * The browser's `cancel` (Escape, Android back). It is only cancelable with fresh user activation:
 * when it isn't, the dialog closes anyway and `modalClosed` reconciles. Exported for tests.
 */
export function modalCancel(e: { cancelable: boolean; preventDefault(): void }, dismissible: boolean, onClose: () => void): void {
  if (!e.cancelable) return;
  e.preventDefault();
  if (dismissible) onClose();
}

/**
 * The dialog's native `close` event. When the browser closed it while React still wants it open, either
 * report the close (dismissible) or show it again, so the DOM and React state never disagree.
 * Our own `close()` (open is false) and stale events from before a reopen (dialog open again) are
 * ignored. Exported for tests.
 */
export function modalClosed(
  dialog: Pick<HTMLDialogElement, 'open' | 'showModal'>,
  open: boolean,
  dismissible: boolean,
  onClose: () => void,
): void {
  if (!open || dialog.open) return;
  if (dismissible) return onClose();
  try {
    dialog.showModal();
  } catch {
    onClose(); // can't be reopened (e.g. detached): at least get React back in sync
  }
}

/**
 * Native <dialog> modal: focus trap, Escape and top-layer stacking come from the browser.
 * Children are only mounted while open, so forms inside start fresh each time.
 */
export function Modal({ open, onClose, title, children, footer, size = 'md', dismissible = true }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedOnBackdrop = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!open) {
      if (d.open) d.close();
      return;
    }
    if (!d.open) d.showModal();
    pushModal(d);
    return () => removeModal(d);
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx('modal', size !== 'md' && `modal-${size}`)}
      aria-labelledby={titleId}
      onKeyDown={(e) => modalKeyDown(e, dismissible)}
      onCancel={(e) => modalCancel(e, dismissible, onClose)}
      onClose={(e) => modalClosed(e.currentTarget, open, dismissible, onClose)}
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Only a press that started AND ended on the backdrop closes (not text-selection drags).
        if (dismissible && pressedOnBackdrop.current && e.target === e.currentTarget) onClose();
        pressedOnBackdrop.current = false;
      }}
    >
      {open && (
        <div className="modal-inner">
          <header className="modal-header">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <CloseIcon />
            </button>
          </header>
          <div className="modal-body">{children}</div>
          {footer && <footer className="modal-footer">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
