"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { CallAnalysis } from "@/lib/sarvam/analysis";
import type { TranscriptSegment } from "@/lib/sarvam/stt";

export interface TranscriptFields {
  transcript_status: "processing" | "done" | "failed" | null;
  transcript: string | null;
  transcript_segments: TranscriptSegment[] | null;
  transcript_error: string | null;
  analysis: CallAnalysis | null;
}

const POLL_MS = 5000;

const QUALITY_STYLE: Record<CallAnalysis["lead_quality"], string> = {
  hot: "bg-red-500/15 text-red-400",
  warm: "bg-amber-500/15 text-amber-400",
  cold: "bg-sky-500/15 text-sky-400",
};

/** POST starts a job; GET polls it. Both return the recording's transcript fields. */
export async function requestTranscription(
  id: string,
  method: "POST" | "GET",
  retry = false,
): Promise<TranscriptFields> {
  const res = await fetch(`/api/calls/${id}/transcribe${retry ? "?retry=1" : ""}`, { method });
  const body = (await res.json().catch(() => ({}))) as TranscriptFields & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Transcription request failed");
  return body;
}

export function CallInsights({
  recordingId,
  fields,
  canStart,
  onChange,
}: {
  recordingId: string;
  fields: TranscriptFields;
  canStart: boolean;
  onChange: (f: TranscriptFields) => void;
}) {
  const t = useTranslations("Calls.insights");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const status = fields.transcript_status;

  // Poll while Sarvam is working.
  useEffect(() => {
    if (status !== "processing") return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const next = await requestTranscription(recordingId, "GET");
        if (!stopped && next.transcript_status !== "processing") onChange(next);
      } catch {
        // transient — keep polling
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [status, recordingId, onChange]);

  async function start(retry = false) {
    setBusy(true);
    try {
      onChange(await requestTranscription(recordingId, "POST", retry));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"));
    }
    setBusy(false);
  }

  if (!status) {
    return canStart ? (
      <button
        type="button"
        onClick={() => start()}
        disabled={busy}
        className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-primary/40 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
        {t("transcribe")}
      </button>
    ) : null;
  }

  if (status === "processing") {
    return (
      <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("processing")}
      </p>
    );
  }

  if (status === "failed") {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-red-400">{t("failedWith", { error: fields.transcript_error ?? "" })}</span>
        {canStart && (
          <button
            type="button"
            onClick={() => start(true)}
            disabled={busy}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <RotateCcw className="h-3 w-3" />
            {t("retry")}
          </button>
        )}
      </div>
    );
  }

  const a = fields.analysis;
  const segments = fields.transcript_segments ?? [];
  const speakerLabel = (n: number) =>
    a ? (n === a.agent_speaker ? t("agent") : t("customer")) : t("speaker", { n });

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-left hover:bg-muted"
      >
        {a ? (
          <>
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", QUALITY_STYLE[a.lead_quality])}>
              {t(`quality.${a.lead_quality}`)}
            </span>
            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              {t("score", { score: a.agent_score })}
            </span>
            <span className="line-clamp-2 flex-1 text-xs text-foreground">{a.summary}</span>
          </>
        ) : (
          <span className="flex-1 text-xs text-muted-foreground">
            {fields.transcript_error ?? t("noAnalysis")}
          </span>
        )}
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="mt-2 space-y-3 rounded-lg border border-border p-3 text-xs">
          {a && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("customerNeed")} value={a.customer_need} />
              <Field label={t("nextStep")} value={a.next_step} />
              {a.team_size && <Field label={t("teamSize")} value={a.team_size} />}
              <List label={t("objections")} items={a.objections} empty={t("none")} />
              <List label={t("didWell")} items={a.agent_did_well} empty={t("none")} />
              <List label={t("improve")} items={a.agent_improve} empty={t("none")} />
            </div>
          )}
          <div>
            <p className="mb-1 font-medium text-muted-foreground">{t("transcript")}</p>
            {segments.length > 0 ? (
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {segments.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span
                      className={cn(
                        "w-16 shrink-0 text-[10px] font-semibold uppercase",
                        a && s.speaker === a.agent_speaker ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {speakerLabel(s.speaker)}
                    </span>
                    <span className="text-foreground">{s.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="whitespace-pre-wrap text-foreground">{fields.transcript || t("noSpeech")}</p>
            )}
          </div>
          {canStart && (
            <button
              type="button"
              onClick={() => start(true)}
              disabled={busy}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3 w-3" />
              {t("redo")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-medium text-muted-foreground">{label}</p>
      <p className="text-foreground">{value || "—"}</p>
    </div>
  );
}

function List({ label, items, empty }: { label: string; items: string[]; empty: string }) {
  return (
    <div>
      <p className="font-medium text-muted-foreground">{label}</p>
      {items.length ? (
        <ul className="list-disc pl-4 text-foreground">
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}
