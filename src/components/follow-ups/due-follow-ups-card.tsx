"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { endOfDay } from "date-fns";
import { ArrowRight, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { FollowUp } from "@/types";
import { isPastDue } from "@/lib/follow-ups/dates";
import { FollowUpRow } from "./follow-up-row";
import { FOLLOW_UP_SELECT } from "./follow-up-meta";

const MAX_ROWS = 5;

/** Dashboard card: the signed-in user's overdue + due-today follow-ups. */
export function DueFollowUpsCard() {
  const t = useTranslations("FollowUps");
  const { user, accountId } = useAuth();
  const [items, setItems] = useState<FollowUp[] | null>(null);

  const load = useCallback(async () => {
    if (!accountId || !user) return;
    const { data, error } = await createClient()
      .from("follow_ups")
      .select(FOLLOW_UP_SELECT)
      .eq("account_id", accountId)
      .eq("assigned_to", user.id)
      .is("completed_at", null)
      .lte("due_at", endOfDay(new Date()).toISOString())
      .order("due_at");
    // Hide the card entirely until migration 043 has been applied.
    setItems(error ? [] : ((data ?? []) as FollowUp[]));
  }, [accountId, user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const toggleDone = useCallback(
    async (f: FollowUp) => {
      setItems((prev) => prev?.filter((x) => x.id !== f.id) ?? prev);
      const { error } = await createClient()
        .from("follow_ups")
        .update({ completed_at: new Date().toISOString() })
        .eq("id", f.id);
      if (error) {
        toast.error(t("toastFailedSave"));
        load();
      } else {
        toast.success(t("toastDone"));
      }
    },
    [load, t],
  );

  if (!items) return null;

  const overdue = items.filter((f) => isPastDue(f.due_at)).length;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <CalendarClock className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t("dashboardTitle")}</h2>
            <p className="text-xs text-muted-foreground">
              {items.length === 0
                ? t("dashboardNone")
                : t("dashboardSummary", { total: items.length, overdue })}
            </p>
          </div>
        </div>
        <Link
          href="/follow-ups"
          className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {t("viewAll")}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {items.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {items.slice(0, MAX_ROWS).map((f) => (
            <li key={f.id}>
              <FollowUpRow followUp={f} compact onToggleDone={toggleDone} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
