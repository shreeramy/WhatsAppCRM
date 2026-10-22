"use client";

import { useEffect, useState } from "react";
import { Loader2, Radio, Users } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Routing = "off" | "test" | "live";

/**
 * Traffic switch for flows on the v2 engine. Renders nothing for other
 * flows. off = original flow for everyone · test = only the listed test
 * numbers · live = everyone.
 */
export function V2RoutingCard({ flowId }: { flowId: string }) {
  const t = useTranslations("Flows.routing");
  const [loaded, setLoaded] = useState(false);
  const [isV2, setIsV2] = useState(false);
  const [routing, setRouting] = useState<Routing>("off");
  const [phones, setPhones] = useState("");
  const [members, setMembers] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [pool, setPool] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/flows/${flowId}/routing`);
      const body = (await res.json().catch(() => ({}))) as {
        v2?: boolean;
        routing?: Routing;
        test_phones?: string[];
        agent_pool?: string[];
        members?: Array<{ id: string; name: string; role: string }>;
      };
      if (cancelled) return;
      setIsV2(!!body.v2);
      setRouting(body.routing ?? "off");
      setPool(body.agent_pool ?? []);
      setMembers(body.members ?? []);
      setPhones((body.test_phones ?? []).join("\n"));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId]);

  if (!loaded || !isV2) return null;

  const save = async (next: Routing) => {
    if (next === "live" && !window.confirm(t("confirmLive"))) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/flows/${flowId}/routing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routing: next,
          test_phones: phones.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? t("saveFailed"));
      setRouting(next);
      toast.success(t(`saved.${next}`));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const savePool = async () => {
    if (!pool.length) {
      toast.error(t("agentPoolEmpty"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/flows/${flowId}/routing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_pool: pool }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? t("saveFailed"));
      toast.success(t("agentPoolSaved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const options: Routing[] = ["off", "test", "live"];

  return (
    <div className="mt-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((o) => (
          <Button
            key={o}
            type="button"
            size="sm"
            variant={routing === o ? "default" : "outline"}
            disabled={saving}
            onClick={() => void save(o)}
            className={cn(o === "live" && routing !== "live" && "border-amber-500/50")}
          >
            {t(`mode.${o}`)}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t(`help.${routing}`)}</p>
      <label className="mt-3 block text-xs font-medium text-foreground">{t("testPhones")}</label>
      <textarea
        value={phones}
        onChange={(e) => setPhones(e.target.value)}
        rows={3}
        placeholder="9198xxxxxxxx"
        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
      />
      <Button type="button" size="sm" variant="outline" className="mt-2" disabled={saving} onClick={() => void save(routing)}>
        {t("savePhones")}
      </Button>

      <div className="mt-5 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">{t("agentPool")}</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("agentPoolHelp")}</p>
        <div className="mt-2 flex flex-col gap-1.5">
          {members.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={pool.includes(m.id)}
                disabled={saving}
                onChange={(e) =>
                  setPool((p) => (e.target.checked ? [...p, m.id] : p.filter((x) => x !== m.id)))
                }
              />
              <span>{m.name}</span>
              <span className="text-xs text-muted-foreground">· {m.role}</span>
            </label>
          ))}
        </div>
        <Button type="button" size="sm" variant="outline" className="mt-2" disabled={saving} onClick={() => void savePool()}>
          {t("saveAgentPool")}
        </Button>
      </div>
    </div>
  );
}
