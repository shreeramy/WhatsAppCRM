"use client";

import { useEffect, useState } from "react";
import { differenceInHours, format } from "date-fns";
import { Check, Copy, ExternalLink, Gift, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button, buttonVariants } from "@/components/ui/button";

type TrialState =
  | { status: "none" }
  | { status: "issued"; url: string; expires_at: string }
  | { status: "expired"; expires_at: string }
  | { status: "unavailable" };

/**
 * The contact's DSA Management free-trial link (one per contact, the same
 * link the WhatsApp bot sends). The server asks DSA Management; this
 * component only ever sees the link itself.
 */
export function ContactTrialLink({ contactId, conversationId }: { contactId: string; conversationId?: string }) {
  const t = useTranslations("Inbox.trialLink");
  const [state, setState] = useState<TrialState | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/contacts/${contactId}/trial-link`, { cache: "no-store" }).catch(() => null);
      const data = res?.ok ? ((await res.json()) as TrialState) : null;
      if (!cancelled) setState(data ?? { status: "none" });
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  // Free-form text needs the 24h customer-service window (same rule as the composer).
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from("messages")
        .select("created_at")
        .eq("conversation_id", conversationId)
        .eq("sender_type", "customer")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const last = (data as { created_at?: string } | null)?.created_at;
      if (!cancelled) setWindowOpen(!!last && differenceInHours(new Date(), new Date(last)) < 24);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  async function getLink() {
    if (busy) return;
    setBusy(true);
    const res = await fetch(`/api/contacts/${contactId}/trial-link`, { method: "POST" }).catch(() => null);
    const data = res?.ok ? ((await res.json()) as TrialState) : null;
    setBusy(false);
    setState(data ?? { status: "unavailable" });
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  async function sendOnWhatsApp(url: string, expiresAt: string) {
    if (!conversationId || sending) return;
    setSending(true);
    // 24h window closed: the server sends the approved trial-link template.
    if (!windowOpen) {
      const res = await fetch(`/api/contacts/${contactId}/trial-link/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      }).catch(() => null);
      setSending(false);
      if (res?.ok) toast.success(t("sentTemplate"));
      else {
        const err = ((await res?.json().catch(() => null)) as { error?: string } | null)?.error;
        toast.error(err ? `${t("sendFailed")} ${err}` : t("sendFailed"));
      }
      return;
    }
    const res = await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        message_type: "text",
        content_text: t("message", { url, date: format(new Date(expiresAt), "d MMM yyyy") }),
      }),
    }).catch(() => null);
    setSending(false);
    if (res?.ok) toast.success(t("sent"));
    else toast.error(t("sendFailed"));
  }

  if (!state) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Gift className="h-3 w-3" />
        {t("title")}
      </div>

      {(state.status === "none" || state.status === "unavailable") && (
        <div className="space-y-1.5 px-1">
          <Button size="sm" className="w-full" onClick={getLink} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Gift className="mr-1.5 h-3.5 w-3.5" />}
            {t("get")}
          </Button>
          {state.status === "unavailable" && <p className="text-xs text-destructive">{t("unavailable")}</p>}
        </div>
      )}

      {state.status === "issued" && (
        <div className="space-y-2 rounded-lg bg-muted px-3 py-2">
          <input
            readOnly
            value={state.url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={t("title")}
            className="w-full truncate rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none"
          />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => copy(state.url)}>
              {copied ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
              {copied ? t("copied") : t("copy")}
            </Button>
            <a
              href={state.url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ size: "sm", variant: "outline", className: "h-7 px-2 text-xs" })}
            >
              <ExternalLink className="mr-1 h-3 w-3" />
              {t("open")}
            </a>
            {conversationId && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => sendOnWhatsApp(state.url, state.expires_at)}
                disabled={sending}
                title={windowOpen ? undefined : t("windowClosed")}
              >
                {sending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
                {t("send")}
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("personal", { date: format(new Date(state.expires_at), "d MMM yyyy") })}
          </p>
        </div>
      )}

      {state.status === "expired" && (
        <p className="px-1 text-xs text-muted-foreground">
          {t("expired", { date: format(new Date(state.expires_at), "d MMM yyyy") })}
        </p>
      )}
    </div>
  );
}
