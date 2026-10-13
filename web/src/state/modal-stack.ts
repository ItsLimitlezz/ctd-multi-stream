// Open modal dialogs, topmost last. A modal <dialog> sits in the browser's top layer and makes
// everything outside it inert, so the toast viewport renders inside the topmost one (see Toast.tsx).

type Listener = () => void;

const stack: HTMLDialogElement[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

/** A modal was shown (or shown again): it becomes the topmost. */
export function pushModal(dialog: HTMLDialogElement): void {
  const i = stack.indexOf(dialog);
  if (i !== -1) stack.splice(i, 1);
  stack.push(dialog);
  emit();
}

export function removeModal(dialog: HTMLDialogElement): void {
  const i = stack.indexOf(dialog);
  if (i === -1) return;
  stack.splice(i, 1);
  emit();
}

/** The topmost open modal, or null. */
export function topModal(): HTMLDialogElement | null {
  return stack[stack.length - 1] ?? null;
}

export function subscribeModals(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
