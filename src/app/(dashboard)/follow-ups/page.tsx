"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { subDays } from "date-fns";
import { CalendarCheck, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { FollowUp, Profile } from "@/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { followUpBucket, type FollowUpBucket } from "@/lib/follow-ups/dates";
import { FollowUpForm } from "@/components/follow-ups/follow-up-form";
import { FollowUpRow } from "@/components/follow-ups/follow-up-row";
import { FOLLOW_UP_SELECT } from "@/components/follow-ups/follow-up-meta";

const TABS: FollowUpBucket[] = ["overdue", "today", "upcoming", "done"];
const DONE_LOOKBACK_DAYS = 30;

export default function FollowUpsPage() {
  const t = useTranslations("FollowUps");
  const { user, accountId, canManageMembers, canSendMessages } = useAuth();

  const [items, setItems] = useState<FollowUp[] | null>(null);
  const [members, setMembers] = useState<Profile[]>([]);
  // null = not picked yet: open on Overdue when something is overdue.
  const [pickedTab, setTab] = useState<FollowUpBucket | null>(null);
  // Managers can look at the whole team; everyone else only has their own.
  const [owner, setOwner] = useState<string>("me");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FollowUp | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const since = subDays(new Date(), DONE_LOOKBACK_DAYS).toISOString();
    const [open, done, m] = await Promise.all([
      supabase
        .from("follow_ups")
        .select(FOLLOW_UP_SELECT)
        .eq("account_id", accountId)
        .is("completed_at", null)
        .order("due_at")
        .limit(500),
      supabase
        .from("follow_ups")
        .select(FOLLOW_UP_SELECT)
        .eq("account_id", accountId)
        .gte("completed_at", since)
        .order("completed_at", { ascending: false })
        .limit(200),
      supabase.from("profiles").select("*").eq("account_id", accountId),
    ]);
    if (open.error || done.error) {
      toast.error(t("toastFailedLoad"));
      setItems([]);
      return;
    }
    setItems([...(open.data ?? []), ...(done.data ?? [])] as FollowUp[]);
    setMembers((m.data ?? []) as Profile[]);
  }, [accountId, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const memberName = useMemo(() => {
    const map = new Map(members.map((m) => [m.user_id, m.full_name || m.email]));
    return (id: string) => map.get(id) ?? null;
  }, [members]);

  const visible = useMemo(() => {
    if (!items) return [];
    if (owner === "all") return items;
    const target = owner === "me" ? user?.id : owner;
    return items.filter((f) => f.assigned_to === target);
  }, [items, owner, user?.id]);

  const byBucket = useMemo(() => {
    const out: Record<FollowUpBucket, FollowUp[]> = {
      overdue: [],
      today: [],
      upcoming: [],
      done: [],
    };
    for (const f of visible) out[followUpBucket(f)].push(f);
    return out;
  }, [visible]);

  const toggleDone = useCallback(
    async (f: FollowUp) => {
      const completed_at = f.completed_at ? null : new Date().toISOString();
      setItems((prev) => prev?.map((x) => (x.id === f.id ? { ...x, completed_at } : x)) ?? prev);
      const { error } = await createClient()
        .from("follow_ups")
        .update({ completed_at })
        .eq("id", f.id);
      if (error) {
        toast.error(t("toastFailedSave"));
        load();
      } else if (completed_at) {
        toast.success(t("toastDone"));
      }
    },
    [load, t],
  );

  const remove = useCallback(
    async (f: FollowUp) => {
      if (!window.confirm(t("deleteConfirm"))) return;
      setItems((prev) => prev?.filter((x) => x.id !== f.id) ?? prev);
      const { error } = await createClient().from("follow_ups").delete().eq("id", f.id);
      if (error) {
        toast.error(t("toastFailedDelete"));
        load();
      }
    },
    [load, t],
  );

  const tab: FollowUpBucket = pickedTab ?? (byBucket.overdue.length > 0 ? "overdue" : "today");
  const showAssignee = canManageMembers && owner !== "me";
  const list = byBucket[tab];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("pageTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("pageDescription")}</p>
        </div>
        <div className="flex items-center gap-2">
          {canManageMembers && (
            <select
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              aria-label={t("filterOwner")}
              className="h-8 rounded-lg border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
            >
              <option value="me">{t("ownerMe")}</option>
              <option value="all">{t("ownerAll")}</option>
              {members
                .filter((m) => m.user_id !== user?.id)
                .map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.full_name || m.email}
                  </option>
                ))}
            </select>
          )}
          {canSendMessages && (
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              {t("newTitle")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setTab(b)}
            className={cn(
              "-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === b
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`tab.${b}`)}
            <span
              className={cn(
                "rounded-full px-1.5 text-[11px]",
                b === "overdue" && byBucket.overdue.length > 0
                  ? "bg-red-500/15 text-red-400"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {byBucket[b].length}
            </span>
          </button>
        ))}
      </div>

      {items === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : list.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/40">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <CalendarCheck className="h-6 w-6 text-primary" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">{t(`empty.${tab}`)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("emptyHint")}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((f) => (
            <li key={f.id}>
              <FollowUpRow
                followUp={f}
                onToggleDone={toggleDone}
                onEdit={
                  canSendMessages
                    ? (x) => {
                        setEditing(x);
                        setFormOpen(true);
                      }
                    : undefined
                }
                onDelete={canSendMessages ? remove : undefined}
                assigneeName={showAssignee ? memberName(f.assigned_to) : null}
              />
            </li>
          ))}
        </ul>
      )}

      <FollowUpForm
        open={formOpen}
        onOpenChange={setFormOpen}
        followUp={editing}
        contactId={editing?.contact_id ?? null}
        onSaved={load}
      />
    </div>
  );
}
