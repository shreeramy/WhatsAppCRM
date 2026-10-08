"use client";

import { useEffect, useState } from "react";
import { Loader2, Shuffle } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

interface Member {
  user_id: string;
  name: string;
  role: string;
}

/**
 * Inbox setting: auto-assign every new conversation round-robin
 * (inbox_settings, migration 053). Applied by the WhatsApp webhook
 * when a chat is first opened. Owners/admins edit; others see it.
 */
export function AutoAssignSettings() {
  const t = useTranslations("AutoAssign");
  const { accountId, canManageMembers } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [pool, setPool] = useState<string[]>([]);
  const [skipOffline, setSkipOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const db = createClient();
      const [settings, profs] = await Promise.all([
        db
          .from("inbox_settings")
          .select("auto_assign_round_robin, auto_assign_agent_ids, auto_assign_skip_offline")
          .eq("account_id", accountId)
          .maybeSingle(),
        db
          .from("profiles")
          .select("user_id, full_name, email, account_role")
          .eq("account_id", accountId)
          .order("full_name"),
      ]);
      if (cancelled) return;
      setEnabled(!!settings.data?.auto_assign_round_robin);
      setPool((settings.data?.auto_assign_agent_ids as string[] | null) ?? []);
      setSkipOffline(!!settings.data?.auto_assign_skip_offline);
      setMembers(
        (profs.data ?? []).map((p) => ({
          user_id: p.user_id as string,
          name: (p.full_name as string) || (p.email as string) || "—",
          role: (p.account_role as string) ?? "",
        })),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  async function save() {
    if (!accountId) return;
    setSaving(true);
    const { error } = await createClient()
      .from("inbox_settings")
      .upsert({
        account_id: accountId,
        auto_assign_round_robin: enabled,
        auto_assign_agent_ids: pool.length ? pool : null,
        auto_assign_skip_offline: skipOffline,
        updated_at: new Date().toISOString(),
      });
    setSaving(false);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    toast.success(t("saved"));
  }

  const agentCount = members.filter((m) => m.role === "agent").length;
  const disabled = !canManageMembers || saving;

  return (
    <section className="mb-6 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Shuffle className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
            <Switch
              checked={enabled}
              onCheckedChange={(v) => setEnabled(!!v)}
              disabled={disabled || loading}
              aria-label={t("title")}
            />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      {loading ? (
        <Loader2 className="mx-auto mt-3 h-4 w-4 animate-spin text-primary" />
      ) : (
        enabled && (
          <div className="mt-3 space-y-2 pl-12">
            <p className="text-xs text-muted-foreground">
              {pool.length === 0
                ? t("poolAllAgents", { count: agentCount })
                : t("poolSelected", { count: pool.length })}
            </p>
            <div className="space-y-0.5">
              {members.map((m) => {
                const checked = pool.includes(m.user_id);
                return (
                  <label key={m.user_id} className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() =>
                        setPool((p) => (checked ? p.filter((id) => id !== m.user_id) : [...p, m.user_id]))
                      }
                    />
                    <span className="flex-1 truncate">{m.name}</span>
                    <span className="text-[10px] uppercase text-muted-foreground">{m.role}</span>
                  </label>
                );
              })}
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={skipOffline}
                disabled={disabled}
                onChange={(e) => setSkipOffline(e.target.checked)}
              />
              {t("skipOffline")}
            </label>
          </div>
        )
      )}

      {canManageMembers && !loading && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("save")}
          </Button>
        </div>
      )}
    </section>
  );
}
