import { describe, expect, it, vi } from 'vitest';
import { pushModal, removeModal, subscribeModals, topModal } from '../state/modal-stack';
import { modalCancel, modalClosed, modalKeyDown } from './Modal';

const event = <T extends object>(extra: T) => ({ preventDefault: vi.fn(), ...extra });
const dialog = (open: boolean) => ({ open, showModal: vi.fn() });

describe('Modal close handling', () => {
  it('stops Escape at keydown only for non-dismissible modals', () => {
    const blocked = event({ key: 'Escape' });
    modalKeyDown(blocked, false);
    expect(blocked.preventDefault).toHaveBeenCalled();
    const allowed = event({ key: 'Escape' });
    modalKeyDown(allowed, true);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    const other = event({ key: 'Enter' });
    modalKeyDown(other, false);
    expect(other.preventDefault).not.toHaveBeenCalled();
  });

  it('cancelable cancel: keeps the dialog and reports the close only when dismissible', () => {
    const onClose = vi.fn();
    const e = event({ cancelable: true });
    modalCancel(e, true, onClose);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    const locked = event({ cancelable: true });
    modalCancel(locked, false, onClose);
    expect(locked.preventDefault).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('non-cancelable cancel (second Escape, Android back) is left to the close handler', () => {
    const onClose = vi.fn();
    const e = event({ cancelable: false });
    modalCancel(e, true, onClose);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a close by the browser while React wants it open is reported (dismissible) or undone', () => {
    const onClose = vi.fn();
    modalClosed(dialog(false), true, true, onClose);
    expect(onClose).toHaveBeenCalledTimes(1);

    const locked = dialog(false);
    modalClosed(locked, true, false, onClose);
    expect(locked.showModal).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    const detached = { open: false, showModal: vi.fn(() => { throw new Error('InvalidStateError'); }) };
    modalClosed(detached, true, false, onClose);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('ignores its own close() and stale close events after a reopen', () => {
    const onClose = vi.fn();
    const d = dialog(false);
    modalClosed(d, false, true, onClose); // React closed it
    modalClosed(dialog(true), true, true, onClose); // reopened before the queued event ran
    modalClosed(d, false, false, onClose);
    expect(onClose).not.toHaveBeenCalled();
    expect(d.showModal).not.toHaveBeenCalled();
  });
});

describe('modal stack', () => {
  it('tracks the topmost open modal', () => {
    const a = {} as HTMLDialogElement;
    const b = {} as HTMLDialogElement;
    const listener = vi.fn();
    const unsubscribe = subscribeModals(listener);
    expect(topModal()).toBeNull();
    pushModal(a);
    pushModal(b);
    expect(topModal()).toBe(b);
    pushModal(a); // shown again: on top
    expect(topModal()).toBe(a);
    removeModal(a);
    expect(topModal()).toBe(b);
    removeModal(a); // not open: no change
    removeModal(b);
    expect(topModal()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(5);
    unsubscribe();
    pushModal(a);
    expect(listener).toHaveBeenCalledTimes(5);
    removeModal(a);
  });
});
