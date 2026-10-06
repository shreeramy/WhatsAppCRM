"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  CalendarCheck,
  DollarSign,
  Loader2,
  Mic,
  StickyNote,
  Tag as TagIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { DateRangeFilter } from "@/components/ui/date-range-filter";
import { resolveRange, type DateRangeValue } from "@/lib/date-range";
import { formatDuration } from "@/lib/call-recordings";
import { formatPhoneDisplay } from "@/lib/whatsapp/phone-utils";
import {
  formatHours,
  loadMemberDailyTime,
  type DailyTime,
  loadMemberActivity,
  loadMemberStats,
  type ActivityItem,
  type ActivityKind,
  type MemberStats,
  type Range,
  type TeamMember,
} from "@/lib/reports/team";

const COLUMNS: { key: keyof MemberStats; labelKey: string; hintKey?: string }[] = [
  { key: "activeSeconds", labelKey: "col.activeTime" },
  { key: "onlineSeconds", labelKey: "col.onlineTime" },
  { key: "messagesSent", labelKey: "col.messagesSent" },
  { key: "notes", labelKey: "col.notes" },
  { key: "tagsAdded", labelKey: "col.tagsAdded" },
  { key: "dealsCreated", labelKey: "col.dealsCreated" },
  { key: "dealsWon", labelKey: "col.dealsWon" },
  { key: "followUpsDone", labelKey: "col.followUpsDone" },
  { key: "recordings", labelKey: "col.recordings" },
  { key: "followUpsOverdue", labelKey: "col.followUpsOverdue", hintKey: "nowHint" },
  { key: "openChats", labelKey: "col.openChats", hintKey: "nowHint" },
  { key: "openDeals", labelKey: "col.openDeals", hintKey: "nowHint" },
];

const KIND_ICON: Record<ActivityKind, typeof StickyNote> = {
  note: StickyNote,
  tag: TagIcon,
  deal: DollarSign,
  followUp: CalendarCheck,
  recording: Mic,
};

function toRange(v: DateRangeValue): Range {
  const r = resolveRange(v);
  return {
    from: r.from?.toISOString() ?? null,
    to: r.to?.toISOString() ?? null,
    fromDay: r.from ? format(r.from, "yyyy-MM-dd") : null,
    toDay: r.to ? format(r.to, "yyyy-MM-dd") : null,
  };
}

const contactLabel = (c: { name?: string | null; phone?: string | null } | null) =>
  c ? c.name || formatPhoneDisplay(c.phone) || null : null;

export default function TeamReportPage() {
  const t = useTranslations("TeamReport");
  const { accountId, canManageMembers, profileLoading } = useAuth();

  const [range, setRange] = useState<DateRangeValue>({ preset: "last7" });
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [stats, setStats] = useState<Record<string, MemberStats> | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<TeamMember | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [dailyTime, setDailyTime] = useState<DailyTime[] | null>(null);
  const [kindFilter, setKindFilter] = useState<ActivityKind | "all">("all");

  const load = useCallback(async () => {
    if (!accountId || !canManageMembers) return;
    const db = createClient();
    setStats(null);
    setError(false);
    const { data } = await db
      .from("profiles")
      .select("id, user_id, full_name, email, account_role")
      .eq("account_id", accountId)
      .order("full_name");
    const list: TeamMember[] = (data ?? []).map((p) => ({
      profileId: p.id as string,
      userId: p.user_id as string,
      name: (p.full_name as string) || (p.email as string) || "—",
      role: (p.account_role as string) ?? "",
    }));
    setMembers(list);
    try {
      const r = toRange(range);
      const rows = await Promise.all(list.map((m) => loadMemberStats(db, accountId, m, r)));
      setStats(Object.fromEntries(list.map((m, i) => [m.userId, rows[i]])));
    } catch (err) {
      console.error("[team-report] load failed:", err);
      setError(true);
    }
  }, [accountId, canManageMembers, range]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Activity list for the picked teammate.
  useEffect(() => {
    if (!selected || !accountId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActivity(null);
    setDailyTime(null);
    loadMemberDailyTime(createClient(), selected, toRange(range))
      .then((d) => !cancelled && setDailyTime(d))
      .catch(() => !cancelled && setDailyTime([]));
    loadMemberActivity(createClient(), accountId, selected, toRange(range), contactLabel)
      .then((items) => !cancelled && setActivity(items))
      .catch((err) => {
        console.error("[team-report] activity failed:", err);
        if (!cancelled) setActivity([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, accountId, range]);

  const totals = useMemo(() => {
    if (!stats) return null;
    const out = {} as MemberStats;
    for (const c of COLUMNS) out[c.key] = 0;
    out.recordingSeconds = 0;
    for (const s of Object.values(stats)) {
      for (const k of Object.keys(out) as (keyof MemberStats)[]) out[k] += s[k];
    }
    return out;
  }, [stats]);

  const shownActivity = (activity ?? []).filter((a) => kindFilter === "all" || a.kind === kindFilter);

  if (!profileLoading && !canManageMembers) {
    return <p className="text-sm text-muted-foreground">{t("adminsOnly")}</p>;
  }

  const cell = (s: MemberStats, key: keyof MemberStats) =>
    key === "activeSeconds" || key === "onlineSeconds"
      ? formatHours(s[key])
      : key === "recordings" && s.recordings
      ? `${s.recordings} · ${formatDuration(s.recordingSeconds) ?? "0:00"}`
      : s[key].toLocaleString();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <DateRangeFilter value={range} onChange={setRange} label={t("period")} />
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">{t("col.member")}</th>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className="px-3 py-2 text-right font-medium"
                  title={c.hintKey ? t(c.hintKey) : undefined}
                >
                  {t(c.labelKey)}
                  {c.hintKey && <span className="text-muted-foreground/60">*</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="px-3 py-6 text-center text-destructive">
                  {t("loadFailed")}
                </td>
              </tr>
            ) : !stats ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="py-10">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
                </td>
              </tr>
            ) : (
              members.map((m) => {
                const s = stats[m.userId];
                if (!s) return null;
                return (
                  <tr
                    key={m.userId}
                    onClick={() => setSelected(m)}
                    className={cn(
                      "cursor-pointer border-b border-border last:border-0 hover:bg-muted/50",
                      selected?.userId === m.userId && "bg-primary/5",
                    )}
                  >
                    <td className="px-3 py-2">
                      <span className="font-medium text-foreground">{m.name}</span>
                      <span className="ml-1.5 text-[10px] uppercase text-muted-foreground">{m.role}</span>
                    </td>
                    {COLUMNS.map((c) => (
                      <td
                        key={c.key}
                        className={cn(
                          "px-3 py-2 text-right tabular-nums",
                          s[c.key] === 0 ? "text-muted-foreground/50" : "text-foreground",
                          c.key === "followUpsOverdue" && s.followUpsOverdue > 0 && "font-semibold text-red-400",
                        )}
                      >
                        {cell(s, c.key)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
          {totals && members.length > 1 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/40 font-semibold">
                <td className="px-3 py-2 text-foreground">{t("total")}</td>
                {COLUMNS.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-right tabular-nums text-foreground">
                    {cell(totals, c.key)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="-mt-3 text-[11px] text-muted-foreground">
        * {t("nowHint")} {t("trackingNote")}
      </p>

      {selected && (
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              {t("activityTitle", { name: selected.name })}
            </h2>
            <div className="flex flex-wrap gap-1">
              {(["all", "note", "tag", "deal", "followUp", "recording"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKindFilter(k)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs",
                    kindFilter === k
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`kind.${k}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-border">
            <p className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {t("timeTitle")}
            </p>
            {dailyTime === null ? (
              <Loader2 className="mx-auto my-3 h-4 w-4 animate-spin text-primary" />
            ) : dailyTime.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">{t("noTime")}</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-1 font-medium">{t("time.day")}</th>
                    <th className="px-3 py-1 text-right font-medium">{t("time.active")}</th>
                    <th className="px-3 py-1 text-right font-medium">{t("time.online")}</th>
                    <th className="px-3 py-1 text-right font-medium">{t("time.firstSeen")}</th>
                    <th className="px-3 py-1 text-right font-medium">{t("time.lastSeen")}</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyTime.map((d) => (
                    <tr key={d.day} className="border-t border-border">
                      <td className="px-3 py-1 text-foreground">
                        {format(new Date(`${d.day}T12:00:00`), "EEE, d MMM")}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-foreground">
                        {formatHours(d.activeSeconds)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">
                        {formatHours(d.onlineSeconds)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">
                        {format(new Date(d.firstSeenAt), "HH:mm")}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">
                        {format(new Date(d.lastSeenAt), "HH:mm")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {activity === null ? (
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
          ) : shownActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noActivity")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {shownActivity.map((a, i) => {
                const Icon = KIND_ICON[a.kind];
                return (
                  <li key={`${a.kind}-${a.at}-${i}`} className="flex items-start gap-3 py-2">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground">
                        <span className="text-muted-foreground">{t(`verb.${a.kind}`)} </span>
                        <span className="font-medium">{a.text}</span>
                        {a.contact && (
                          <span className="text-muted-foreground">
                            {" "}
                            · {a.contact}
                          </span>
                        )}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {format(new Date(a.at), "d MMM, HH:mm")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
