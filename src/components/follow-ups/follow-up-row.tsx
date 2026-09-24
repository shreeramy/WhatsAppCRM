"use client";

import Link from "next/link";
import { format } from "date-fns";
import { Check, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { FollowUp } from "@/types";
import { cn } from "@/lib/utils";
import { followUpBucket } from "@/lib/follow-ups/dates";
import { FOLLOW_UP_TYPE_ICON } from "./follow-up-meta";

interface FollowUpRowProps {
  followUp: FollowUp;
  onToggleDone: (f: FollowUp) => void;
  onEdit?: (f: FollowUp) => void;
  onDelete?: (f: FollowUp) => void;
  /** Shown when an admin is looking at teammates' follow-ups. */
  assigneeName?: string | null;
  /** Hide the contact line (e.g. inside that contact's chat). */
  hideContact?: boolean;
  compact?: boolean;
}

export function FollowUpRow({
  followUp: f,
  onToggleDone,
  onEdit,
  onDelete,
  assigneeName,
  hideContact,
  compact,
}: FollowUpRowProps) {
  const t = useTranslations("FollowUps");
  const bucket = followUpBucket(f);
  const Icon = FOLLOW_UP_TYPE_ICON[f.type] ?? FOLLOW_UP_TYPE_ICON.task;
  const done = bucket === "done";
  const contactLabel = f.contact ? f.contact.name || f.contact.phone : null;
  const chatHref = f.conversation_id
    ? `/inbox?c=${f.conversation_id}`
    : null;

  return (
    <div
      className={cn(
        "group flex items-start gap-2.5 rounded-lg border bg-card",
        compact ? "px-2.5 py-2" : "px-3 py-3",
        bucket === "overdue" ? "border-red-500/40" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => onToggleDone(f)}
        aria-label={done ? t("markOpen") : t("markDone")}
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
          done
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/50 hover:border-primary",
        )}
      >
        {done && <Check className="h-3 w-3" />}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "truncate text-sm font-medium",
              done ? "text-muted-foreground line-through" : "text-foreground",
            )}
          >
            {f.title}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span
            className={cn(
              bucket === "overdue" && "font-semibold text-red-400",
              bucket === "today" && "font-semibold text-primary",
            )}
          >
            {bucket === "overdue" && `${t("overdue")} · `}
            {format(new Date(f.due_at), compact ? "d MMM, HH:mm" : "EEE d MMM, HH:mm")}
          </span>
          {!hideContact && contactLabel && <span className="truncate">{contactLabel}</span>}
          {f.deal && <span className="truncate">· {f.deal.title}</span>}
          {assigneeName && <span className="truncate">· {assigneeName}</span>}
        </div>
        {!compact && f.notes && (
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
            {f.notes}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100">
        {chatHref && !hideContact && (
          <Link
            href={chatHref}
            aria-label={t("openChat")}
            title={t("openChat")}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Link>
        )}
        {onEdit && (
          <button
            type="button"
            onClick={() => onEdit(f)}
            aria-label={t("edit")}
            title={t("edit")}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(f)}
            aria-label={t("delete")}
            title={t("delete")}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
