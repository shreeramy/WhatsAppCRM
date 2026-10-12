"use client";

import { useEffect } from "react";
import { useBrowserNotifications } from "@/hooks/use-browser-notifications";
import { refreshPushSubscription } from "@/lib/push/client";

/**
 * Headless. Mount ONCE per signed-in dashboard tab (the dashboard
 * shell, below the auth gate) so desktop notifications for new customer
 * messages fire on every dashboard page, not just the inbox.
 *
 * Also moves this device's push subscription onto the current server
 * key if it was made with an old one (VAPID key rotation).
 */
export function BrowserNotificationsListener() {
  useBrowserNotifications();
  useEffect(() => {
    refreshPushSubscription().catch((err) =>
      console.warn("[push] could not refresh subscription:", err),
    );
  }, []);
  return null;
}
