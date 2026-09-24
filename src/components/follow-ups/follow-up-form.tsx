"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Contact, Deal, FollowUp, FollowUpType, Profile } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  QUICK_PICKS,
  fromDateTimeInputs,
  quickPickDate,
  toDateTimeInputs,
} from "@/lib/follow-ups/dates";
import { FOLLOW_UP_TYPES, FOLLOW_UP_TYPE_ICON } from "./follow-up-meta";

interface FollowUpFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing row to edit. Omit to create. */
  followUp?: FollowUp | null;
  /** Pre-selected contact. When set, the contact picker is hidden. */
  contactId?: string | null;
  dealId?: string | null;
  conversationId?: string | null;
  onSaved?: () => void;
}

const selectClass =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary";

export function FollowUpForm({
  open,
  onOpenChange,
  followUp,
  contactId: fixedContactId,
  dealId: defaultDealId,
  conversationId,
  onSaved,
}: FollowUpFormProps) {
  const t = useTranslations("FollowUps");
  const { user, accountId } = useAuth();

  const [type, setType] = useState<FollowUpType>("call");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [assignedTo, setAssignedTo] = useState("");
  const [contactId, setContactId] = useState("");
  const [dealId, setDealId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const [members, setMembers] = useState<Profile[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);

  // Reset whenever the dialog opens.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    if (followUp) {
      const inputs = toDateTimeInputs(new Date(followUp.due_at));
      setType(followUp.type);
      setTitle(followUp.title);
      setDate(inputs.date);
      setTime(inputs.time);
      setAssignedTo(followUp.assigned_to);
      setContactId(followUp.contact_id ?? "");
      setDealId(followUp.deal_id ?? "");
      setNotes(followUp.notes ?? "");
    } else {
      const inputs = toDateTimeInputs(quickPickDate("tomorrow"));
      setType("call");
      setTitle("");
      setDate(inputs.date);
      setTime(inputs.time);
      setAssignedTo(user?.id ?? "");
      setContactId(fixedContactId ?? "");
      setDealId(defaultDealId ?? "");
      setNotes("");
    }
  }, [open, followUp, fixedContactId, defaultDealId, user?.id]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Team members + (when no contact is fixed) the contact list.
  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const [m, c] = await Promise.all([
        supabase
          .from("profiles")
          .select("*")
          .eq("account_id", accountId)
          .order("full_name"),
        fixedContactId
          ? Promise.resolve({ data: [] })
          : supabase.from("contacts").select("id, name, phone").order("name"),
      ]);
      if (cancelled) return;
      setMembers((m.data ?? []) as Profile[]);
      setContacts((c.data ?? []) as Contact[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, accountId, fixedContactId]);

  // Deals for the chosen contact.
  useEffect(() => {
    if (!open || !contactId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDeals([]);
      return;
    }
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const { data } = await supabase
        .from("deals")
        .select("id, title, status")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      setDeals((data ?? []) as Deal[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId]);

  const dueIso = useMemo(() => fromDateTimeInputs(date, time), [date, time]);
  const canSave = !!title.trim() && !!dueIso && !!assignedTo && !saving;

  async function handleSave() {
    if (!canSave || !dueIso) return;
    if (!accountId || !user) {
      toast.error(t("toastNotLinked"));
      return;
    }
    setSaving(true);
    const supabase = createClient();
    const payload = {
      type,
      title: title.trim(),
      notes: notes.trim() || null,
      due_at: dueIso,
      assigned_to: assignedTo,
      contact_id: contactId || null,
      deal_id: dealId || null,
    };

    const { error } = followUp
      ? await supabase.from("follow_ups").update(payload).eq("id", followUp.id)
      : await supabase.from("follow_ups").insert({
          ...payload,
          account_id: accountId,
          created_by: user.id,
          conversation_id: conversationId ?? null,
        });

    setSaving(false);
    if (error) {
      console.error("Failed to save follow-up:", error.message);
      toast.error(t("toastFailedSave"));
      return;
    }
    toast.success(followUp ? t("toastUpdated") : t("toastCreated"));
    onOpenChange(false);
    onSaved?.();
  }

  function applyQuickPick(pick: (typeof QUICK_PICKS)[number]) {
    const inputs = toDateTimeInputs(quickPickDate(pick));
    setDate(inputs.date);
    setTime(inputs.time);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {followUp ? t("editTitle") : t("newTitle")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("formDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          {/* Type */}
          <div className="grid grid-cols-4 gap-1.5">
            {FOLLOW_UP_TYPES.map((ft) => {
              const Icon = FOLLOW_UP_TYPE_ICON[ft];
              return (
                <button
                  key={ft}
                  type="button"
                  onClick={() => setType(ft)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[11px] font-medium transition-colors",
                    type === ft
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {t(`type.${ft}`)}
                </button>
              );
            })}
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t("fieldTitle")}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("fieldTitlePlaceholder")}
              className="bg-muted border-border text-foreground"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t("fieldDue")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_PICKS.map((pick) => (
                <button
                  key={pick}
                  type="button"
                  onClick={() => applyQuickPick(pick)}
                  className="rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
                >
                  {t(`quick.${pick}`)}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="bg-muted border-border text-foreground"
              />
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="bg-muted border-border text-foreground"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t("fieldAssignee")}</Label>
            <select
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              className={selectClass}
            >
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {(m.full_name || m.email) + (m.user_id === user?.id ? ` (${t("me")})` : "")}
                </option>
              ))}
            </select>
          </div>

          {!fixedContactId && (
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t("fieldContact")}</Label>
              <select
                value={contactId}
                onChange={(e) => {
                  setContactId(e.target.value);
                  setDealId("");
                }}
                className={selectClass}
              >
                <option value="">{t("noContact")}</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.phone}
                  </option>
                ))}
              </select>
            </div>
          )}

          {contactId && (
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t("fieldDeal")}</Label>
              <select
                value={dealId}
                onChange={(e) => setDealId(e.target.value)}
                className={selectClass}
              >
                <option value="">{t("noDeal")}</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t("fieldNotes")}</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("fieldNotesPlaceholder")}
              className="min-h-[70px] bg-muted border-border text-foreground"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border bg-transparent text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {followUp ? t("save") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
