import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { subscribeModals, topModal } from '../state/modal-stack';
import { dismissToast, useToasts } from '../state/toast';
import { CloseIcon } from './icons';

export { toast, dismissToast } from '../state/toast';

/** Renders toasts raised with `toast()` anywhere in the app. Mount once near the root. */
export function ToastProvider({ children }: { children?: ReactNode }) {
  return (
    <>
      {children}
      <ToastViewport />
    </>
  );
}

function ToastViewport() {
  const toasts = useToasts();
  // A modal <dialog> is in the top layer and makes the rest of the page inert, so while one is open
  // the toasts render inside it (position: fixed still places them at the viewport corner).
  const modal = useSyncExternalStore(subscribeModals, topModal, () => null);
  const viewport = (
    <div className="toast-viewport" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          <span className="toast-msg">
            {t.message}
            {t.count > 1 && <span className="toast-count">×{t.count}</span>}
          </span>
          <button type="button" className="icon-btn" aria-label="Dismiss notification" onClick={() => dismissToast(t.id)}>
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      ))}
    </div>
  );
  return modal ? createPortal(viewport, modal) : viewport;
}
