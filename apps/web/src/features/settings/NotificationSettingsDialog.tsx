import { AppearanceControls } from '../appearance/AppearanceControls';
import { useEffect, useState, type RefObject } from 'react';
import { Button } from '../../design-system/ui/Button';
import { Dialog } from '../../design-system/ui/Dialog';
import { Header, InlineHeader } from '../../design-system/ui/Header';
import { PreferenceRow } from '../../design-system/ui/PreferenceRow';
import { SettingsGroup } from '../../design-system/ui/SettingsGroup';
import { SwitchPreferenceRow } from '../../design-system/ui/SwitchPreferenceRow';

const permissionMessages = {
  default: 'Allow notifications in your browser to receive desktop alerts.',
  granted: 'Notifications are allowed in this browser.',
  denied: 'Notifications are blocked. Allow them in your browser’s site settings.',
  unsupported: 'This browser can’t show desktop notifications.',
};

function readPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export function NotificationSettingsDialog({
  open,
  onOpenChange,
  triggerRef,
  enabled,
  onEnabledChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const [permission, setPermission] = useState(readPermission);
  const [requesting, setRequesting] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);

  function checkPermission() {
    setPermission(readPermission());
    setRequestFailed(false);
  }

  useEffect(() => {
    if (!open) return;
    checkPermission();
    window.addEventListener('focus', checkPermission);
    return () => window.removeEventListener('focus', checkPermission);
  }, [open]);

  async function allowNotifications() {
    const current = readPermission();
    if (requesting || current !== 'default') {
      setPermission(current);
      return;
    }

    setRequesting(true);
    setRequestFailed(false);
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission(readPermission());
      setRequestFailed(true);
    } finally {
      setRequesting(false);
    }
  }

  let status = permissionMessages[permission];
  if (requesting) status = 'Waiting for browser permission…';
  else if (requestFailed && permission === 'default') {
    status = 'Could not request permission. Try again.';
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Settings" finalFocus={triggerRef}>
      <section aria-labelledby="appearance-settings-title">
        <Header id="appearance-settings-title" title="Appearance" />
        <AppearanceControls />
      </section>
      <section aria-labelledby="notification-settings-title" style={{ marginBlockStart: 'var(--space-6)' }}>
        <Header id="notification-settings-title" title="Notifications" />
        <section aria-labelledby="notification-delivery-title">
          <InlineHeader id="notification-delivery-title" title="Delivery" />
          <SettingsGroup>
            <SwitchPreferenceRow
              label="Desktop alerts"
              description="Receive alerts while BubAI is open."
              checked={enabled}
              onCheckedChange={onEnabledChange}
            />
            <PreferenceRow
              title="Browser permission"
              subtitle={<span role="status">{status}</span>}
              trailing={
                permission === 'default' ? (
                  <Button
                    variant="link"
                    size="sm"
                    loading={requesting}
                    onClick={() => void allowNotifications()}
                  >
                    Allow notifications
                  </Button>
                ) : permission !== 'unsupported' ? (
                  <Button variant="link" size="sm" disabled={requesting} onClick={checkPermission}>
                    Check permission
                  </Button>
                ) : null
              }
            />
          </SettingsGroup>
        </section>
      </section>
    </Dialog>
  );
}
