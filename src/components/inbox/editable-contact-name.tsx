"use client";

import { useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Contact } from "@/types";

interface EditableContactNameProps {
  contact: Contact;
  /** Shown when the contact has no name (phone / handle). */
  fallback: string;
  onSaved: (contact: Contact) => void;
  className?: string;
  align?: "left" | "center";
}

/**
 * Click the name to edit it; Enter or clicking away saves, Escape
 * cancels. Read-only for viewers.
 */
export function EditableContactName({
  contact,
  fallback,
  onSaved,
  className,
  align = "left",
}: EditableContactNameProps) {
  const t = useTranslations("Inbox.editName");
  const { canSendMessages } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // Escape sets this so the blur that follows doesn't save.
  const cancelled = useRef(false);

  const display = contact.name || fallback;

  function startEditing() {
    if (!canSendMessages || saving) return;
    cancelled.current = false;
    setDraft(contact.name ?? "");
    setEditing(true);
  }

  async function save() {
    setEditing(false);
    if (cancelled.current) return;
    const name = draft.trim();
    if (name === (contact.name ?? "")) return;

    setSaving(true);
    // Optimistic — list, header and sidebar update immediately.
    onSaved({ ...contact, name });
    const { error } = await createClient()
      .from("contacts")
      .update({ name })
      .eq("id", contact.id);
    setSaving(false);
    if (error) {
      onSaved(contact);
      toast.error(t("failed"));
      return;
    }
    toast.success(t("saved"));
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
        placeholder={t("placeholder")}
        aria-label={t("label")}
        maxLength={120}
        className={cn(
          "w-full min-w-0 rounded-md border border-primary/60 bg-muted px-1.5 py-0.5 font-semibold text-foreground outline-none",
          align === "center" && "text-center",
          className,
        )}
      />
    );
  }

  if (!canSendMessages) {
    return <span className={cn("truncate font-semibold text-foreground", className)}>{display}</span>;
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      title={t("hint")}
      className={cn(
        "group inline-flex max-w-full min-w-0 items-center gap-1 rounded-md px-1 -mx-1 font-semibold text-foreground hover:bg-muted",
        align === "center" && "justify-center",
        className,
      )}
    >
      <span className="truncate">{display}</span>
      <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
