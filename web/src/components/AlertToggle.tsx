import { useState, type ReactNode } from 'react';
import { disableAlerts, enableAlerts, notificationHint, useAlertPrefs, type NotificationStatus } from '../state/alerts';
import { Field } from './Field';
import { toast } from './Toast';
import { Toggle } from './Toggle';

/** Toast shown after alerts were switched on, depending on what notifications can do here. */
export function alertsEnabledMessage(status: NotificationStatus): { tone: 'success' | 'info'; message: string } {
  if (status === 'granted') {
    return { tone: 'success', message: 'Alerts on: you will hear a sound and get a notification when a platform ends the live.' };
  }
  return { tone: 'info', message: `Alerts on (sound only). ${notificationHint(status) ?? ''}`.trim() };
}

/** On/off state of the per-browser alerts, with the enable flow (sound unlock + permission prompt). */
export function useAlertToggle() {
  const prefs = useAlertPrefs();
  const [busy, setBusy] = useState(false);
  const setEnabled = (on: boolean) => {
    if (!on) {
      disableAlerts();
      return;
    }
    // Synchronous up to the permission prompt so it runs inside the click (user gesture).
    setBusy(true);
    enableAlerts()
      .then((status) => {
        const { tone, message } = alertsEnabledMessage(status);
        toast(message, { tone });
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return { enabled: prefs.enabled, prefs, busy, setEnabled };
}

export interface AlertToggleProps {
  label?: ReactNode;
  help?: ReactNode;
}

/** "Alert me" switch: sound + browser notification for takedowns and failures (this browser only). */
export function AlertToggle({
  label = 'Alert me',
  help = 'Sound + browser notification when a platform ends the live or a destination fails (this browser only)',
}: AlertToggleProps) {
  const { enabled, busy, setEnabled } = useAlertToggle();
  return (
    <Field label={label} help={help} inline>
      <Toggle checked={enabled} busy={busy} onChange={setEnabled} />
    </Field>
  );
}
