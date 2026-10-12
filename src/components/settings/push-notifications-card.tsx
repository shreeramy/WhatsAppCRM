'use client';

import { useEffect, useState } from 'react';
import { BellRing, CircleAlert, Loader2, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  disablePush,
  enablePush,
  getPushSubscription,
  needsIosInstall,
  pushSupported,
} from '@/lib/push/client';

/**
 * "Push notifications" card — per-device opt-in for real Web Push, so new
 * customer messages show up as a phone notification even when the CRM
 * is in the background or closed.
 */
export function PushNotificationsCard({ className }: { className?: string }) {
  const t = useTranslations('Settings.pushNotifications');
  const [state, setState] = useState<'loading' | 'unsupported' | 'ios' | 'on' | 'off'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next: typeof state;
      if (needsIosInstall()) next = 'ios';
      else if (!pushSupported()) next = 'unsupported';
      else next = (await getPushSubscription().catch(() => null)) ? 'on' : 'off';
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (!next) {
        await disablePush();
        setState('off');
        return;
      }
      const result = await enablePush();
      if (result === 'ok') {
        setState('on');
        toast.success(t('enabledToast'));
      } else if (result === 'denied') {
        toast.error(t('deniedToast'), { description: t('deniedHint') });
      } else {
        toast.error(t('unconfigured'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('failed'));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { sent?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? t('failed'));
      if (!body.sent) toast.error(t('testNone'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Smartphone className="size-4 text-muted-foreground" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state === 'ios' ? (
          <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{t('iosHint')}</span>
          </p>
        ) : state === 'unsupported' ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleAlert className="size-4 shrink-0" />
            {t('unsupported')}
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t('toggleLabel')}</p>
                <p className="text-xs text-muted-foreground">{t('toggleDesc')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {(busy || state === 'loading') && (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                )}
                <Switch
                  checked={state === 'on'}
                  onCheckedChange={(next) => void onToggle(next)}
                  disabled={busy || state === 'loading'}
                  aria-label={t('toggleLabel')}
                />
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void sendTest()}
              disabled={busy || state !== 'on'}
            >
              <BellRing className="size-4" />
              {t('sendTest')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
