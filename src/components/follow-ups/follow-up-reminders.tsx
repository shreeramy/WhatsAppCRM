"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import type { Notification } from "@/types";

const CHECK_INTERVAL_MS = 60_000;

/**
 * Headless. Mounted once in the dashboard shell.
 *
 * 1. Every minute, asks the database to turn this user's due follow-ups
 *    into notifications (`notify_due_follow_ups`). pg_cron does the same
 *    server-side when enabled; this keeps reminders working without it.
 * 2. Pops a toast when a follow-up reminder notification arrives, so the
 *    salesperson sees it on whatever page they're on.
 */
export function FollowUpReminders() {
  const router = useRouter();
  const t = useTranslations("FollowUps");

  useEffect(() => {
    const supabase = createClient();
    let stopped = false;

    const check = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      const { error } = await supabase.rpc("notify_due_follow_ups");
      // Missing function = migration 043 not applied yet; stay quiet.
      if (error && error.code !== "PGRST202") {
        console.warn("[follow-ups] reminder check failed:", error.message);
      }
    };

    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);

    const channel = supabase
      .channel("follow-up-reminder-toasts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications" },
        (payload) => {
          const n = payload.new as Notification;
          if (n.type !== "follow_up_due") return;
          toast(n.title, {
            description: n.body,
            duration: 15_000,
            action: {
              label: n.conversation_id ? t("openChat") : t("viewAll"),
              onClick: () =>
                router.push(
                  n.conversation_id ? `/inbox?c=${n.conversation_id}` : "/follow-ups",
                ),
            },
          });
        },
      )
      .subscribe();

    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [router, t]);

  return null;
}
