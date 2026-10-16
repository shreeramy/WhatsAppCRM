"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNowStrict } from "date-fns";
import {
  CalendarCheck,
  Clock,
  IndianRupee,
  Loader2,
  MessageCircle,
  Phone,
  PhoneOff,
  SkipForward,
  X,
  PartyPopper,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { formatPhoneDisplay, withIndiaCountryCode } from "@/lib/whatsapp/phone-utils";
import type { Outcome, QueueItem } from "@/lib/call-next/queue";

interface QueueResponse {
  items: QueueItem[];
  doneToday: number;
  counts: { now: number; today: number };
  agentId: string;
  team?: Array<{ userId: string; name: string }>;
}

const SKIP_KEY = "wacrm:call-next-skipped";
const SKIP_MS = 60 * 60 * 1000;

function readSkipped(): Record<string, number> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SKIP_KEY) ?? "{}") as Record<string, number>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw).filter(([, until]) => until > now));
  } catch {
    return {};
  }
}

function writeSkipped(map: Record<string, number>) {
  try {
    window.localStorage.setItem(SKIP_KEY, JSON.stringify(map));
  } catch {
    // per-device convenience only
  }
}

/** Quick time choices in the agent's local time. */
function quickTimes(now: Date): Array<{ key: string; at: Date }> {
  const at = (dayOffset: number, h: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, 0, 0, 0);
    return d;
  };
  const list = [
    { key: "todayEvening", at: at(0, 18) },
    { key: "tomorrowMorning", at: at(1, 11) },
    { key: "tomorrowEvening", at: at(1, 17) },
  ];
  return list.filter((x) => x.at.getTime() > now.getTime() + 15 * 60000);
}

export default function CallNextPage() {
  const t = useTranslations("CallNext");
  const router = useRouter();
  const { canManageMembers: canPickAgent } = useAuth();

  const [data, setData] = useState<QueueResponse | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [skipped, setSkipped] = useState<Record<string, number>>({});
  // The lead whose call outcome we're asking for (set when "Call" is tapped).
  const [asking, setAsking] = useState<QueueItem | null>(null);
  const [step, setStep] = useState<"choose" | "time-demo" | "time-later" | "reason">("choose");
  const [customTime, setCustomTime] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/call-next${agent ? `?agent=${agent}` : ""}`);
    const body = (await res.json().catch(() => null)) as QueueResponse | { error?: string } | null;
    if (!res.ok || !body || !("items" in body)) {
      toast.error((body as { error?: string } | null)?.error ?? t("loadFailed"));
      setLoading(false);
      return;
    }
    setData(body);
    setLoading(false);
  }, [agent, t]);

  useEffect(() => {
    setSkipped(readSkipped());
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const queue = useMemo(
    () => (data?.items ?? []).filter((i) => (skipped[i.contactId] ?? 0) <= Date.now()),
    [data, skipped],
  );
  const lead = asking ?? queue[0] ?? null;
  const remaining = queue.length;
  const done = data?.doneToday ?? 0;

  const skip = (item: QueueItem) => {
    const next = { ...readSkipped(), [item.contactId]: Date.now() + SKIP_MS };
    writeSkipped(next);
    setSkipped(next);
  };

  const startCall = (item: QueueItem) => {
    setAsking(item);
    setStep("choose");
    setCustomTime("");
  };

  const save = async (outcome: Outcome, opts: { at?: Date; reason?: string } = {}) => {
    if (!asking) return;
    setSaving(true);
    try {
      const res = await fetch("/api/call-next/outcome", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: asking.contactId,
          conversationId: asking.conversationId,
          outcome,
          at: opts.at?.toISOString() ?? null,
          reason: opts.reason ?? null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? t("saveFailed"));
      toast.success(t(`saved.${outcome}`));
      setAsking(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const reasonText = (item: QueueItem) => {
    const ago = formatDistanceToNowStrict(new Date(item.since));
    const at = new Date(item.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    switch (item.reason) {
      case "followUpOverdue":
        return t("reason.followUpOverdue", { ago, title: item.followUpTitle ?? "" });
      case "followUpToday":
        return t("reason.followUpToday", { at, title: item.followUpTitle ?? "" });
      case "demoSoon":
        return t("reason.demoSoon", { at });
      default:
        return t(`reason.${item.reason}`, { ago });
    }
  };

  const total = done + remaining;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="mx-auto w-full max-w-md space-y-4 pb-10">
      {canPickAgent && data?.team && (
        <select
          value={agent ?? data.agentId}
          onChange={(e) => {
            setAsking(null);
            setLoading(true);
            setAgent(e.target.value);
          }}
          className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          aria-label={t("agentPicker")}
        >
          {data.team.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </select>
      )}

      {/* Progress */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("remaining", { count: remaining })}</span>
          <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            {t("doneToday", { count: done })}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        {data && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("split", { now: data.counts.now, today: data.counts.today })}
          </p>
        )}
      </div>

      {loading && !data ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !lead ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-14 text-center">
          <PartyPopper className="mx-auto h-8 w-8 text-emerald-500" />
          <p className="mt-3 font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("emptyBody")}</p>
        </div>
      ) : asking ? (
        /* After the call: what happened? */
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="text-base font-medium text-foreground">{t("whatHappened", { name: asking.name })}</p>
            <button
              type="button"
              onClick={() => setAsking(null)}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label={t("cancel")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {step === "choose" && (
            <div className="mt-4 grid gap-2">
              <OutcomeButton icon={CalendarCheck} label={t("outcome.demo_booked")} onClick={() => setStep("time-demo")} disabled={saving} />
              <OutcomeButton icon={IndianRupee} label={t("outcome.will_pay")} onClick={() => void save("will_pay")} disabled={saving} />
              <OutcomeButton icon={Clock} label={t("outcome.call_later")} onClick={() => setStep("time-later")} disabled={saving} />
              <OutcomeButton icon={PhoneOff} label={t("outcome.no_answer")} onClick={() => void save("no_answer")} disabled={saving} />
              <OutcomeButton icon={X} label={t("outcome.not_interested")} onClick={() => setStep("reason")} disabled={saving} />
              <p className="mt-1 text-xs text-muted-foreground">{t("autoHint")}</p>
            </div>
          )}

          {(step === "time-demo" || step === "time-later") && (
            <div className="mt-4 grid gap-2">
              <p className="text-sm text-muted-foreground">{step === "time-demo" ? t("whenDemo") : t("whenCall")}</p>
              {quickTimes(new Date()).map((q) => (
                <Button
                  key={q.key}
                  variant="outline"
                  className="h-11 justify-start"
                  disabled={saving}
                  onClick={() => void save(step === "time-demo" ? "demo_booked" : "call_later", { at: q.at })}
                >
                  {t(`time.${q.key}`)}
                </Button>
              ))}
              <div className="flex gap-2">
                <input
                  type="datetime-local"
                  value={customTime}
                  onChange={(e) => setCustomTime(e.target.value)}
                  className="h-11 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                  aria-label={t("pickTime")}
                />
                <Button
                  className="h-11"
                  disabled={saving || !customTime}
                  onClick={() => void save(step === "time-demo" ? "demo_booked" : "call_later", { at: new Date(customTime) })}
                >
                  {t("save")}
                </Button>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setStep("choose")}>
                {t("back")}
              </Button>
            </div>
          )}

          {step === "reason" && (
            <div className="mt-4 grid gap-2">
              <p className="text-sm text-muted-foreground">{t("whyNot")}</p>
              {(["price", "not_dsa", "other_tool", "other"] as const).map((r) => (
                <Button key={r} variant="outline" className="h-11 justify-start" disabled={saving} onClick={() => void save("not_interested", { reason: r })}>
                  {t(`notInterestedReason.${r}`)}
                </Button>
              ))}
              <Button variant="ghost" size="sm" onClick={() => setStep("choose")}>
                {t("back")}
              </Button>
            </div>
          )}
          {saving && <Loader2 className="mx-auto mt-3 h-5 w-5 animate-spin text-muted-foreground" />}
        </div>
      ) : (
        /* The next lead */
        <div className="rounded-xl border border-border bg-card p-4">
          <span
            className={cn(
              "inline-block rounded-md px-2 py-0.5 text-xs font-medium",
              lead.tier === "now"
                ? "bg-red-500/15 text-red-600 dark:text-red-400"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
            )}
          >
            {lead.tier === "now" ? t("tierNow") : t("tierToday")}
          </span>
          <p className="mt-3 text-xl font-semibold text-foreground">{lead.name}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {reasonText(lead)}
            {lead.dealValue ? ` · ₹${Number(lead.dealValue).toLocaleString("en-IN")}` : ""}
          </p>
          {lead.phone && <p className="mt-0.5 text-xs text-muted-foreground">{formatPhoneDisplay(lead.phone)}</p>}
          {lead.lastMessage && (
            <p className="mt-3 line-clamp-3 rounded-md bg-muted/60 px-3 py-2 text-sm text-foreground">“{lead.lastMessage}”</p>
          )}

          {lead.phone ? (
            <a
              href={`tel:+${withIndiaCountryCode(lead.phone).replace(/\D/g, "")}`}
              onClick={() => startCall(lead)}
              className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 text-base font-medium text-white hover:bg-emerald-700"
            >
              <Phone className="h-5 w-5" />
              {t("call")}
            </a>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">{t("noPhone")}</p>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="h-10"
              onClick={() => lead.conversationId && router.push(`/inbox?c=${lead.conversationId}`)}
              disabled={!lead.conversationId}
            >
              <MessageCircle className="h-4 w-4" />
              {t("chat")}
            </Button>
            <Button variant="outline" className="h-10" onClick={() => skip(lead)}>
              <SkipForward className="h-4 w-4" />
              {t("later")}
            </Button>
          </div>
          <button type="button" onClick={() => startCall(lead)} className="mt-3 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline">
            {t("alreadyCalled")}
          </button>
        </div>
      )}

      {/* What's coming up */}
      {!asking && queue.length > 1 && (
        <div className="rounded-xl border border-border bg-card">
          <p className="border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground">{t("upNext")}</p>
          <ul>
            {queue.slice(1, 6).map((i) => (
              <li key={i.contactId} className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm last:border-b-0">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", i.tier === "now" ? "bg-red-500" : "bg-amber-500")} />
                <span className="min-w-0 flex-1 truncate text-foreground">{i.name}</span>
                <span className="shrink-0 truncate text-xs text-muted-foreground">{t(`short.${i.reason}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function OutcomeButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Phone;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-12 items-center gap-3 rounded-lg border border-border px-3 text-left text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      {label}
    </button>
  );
}
