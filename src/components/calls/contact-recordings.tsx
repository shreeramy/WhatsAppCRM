"use client";

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { Loader2, Mic, Play } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CALL_RECORDINGS_BUCKET, formatDuration } from "@/lib/call-recordings";
import { CallInsights, type TranscriptFields } from "@/components/calls/call-insights";

type Recording = TranscriptFields & {
  id: string;
  storage_path: string;
  duration_seconds: number | null;
  uploaded_by: string | null;
  created_at: string;
};

const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * A contact's call recordings (matched by the phone number in the file
 * name at upload), shown on the deal and in the chat sidebar. Renders
 * nothing when the contact has none.
 */
export function ContactRecordings({ contactId }: { contactId: string | null | undefined }) {
  const t = useTranslations("Calls");
  const { user } = useAuth();
  const [recs, setRecs] = useState<Recording[]>([]);
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    if (!contactId) return;
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from("call_recordings")
        .select(
          "id, storage_path, duration_seconds, uploaded_by, created_at, transcript_status, transcript, transcript_segments, transcript_error, analysis",
        )
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (!cancelled) setRecs((data ?? []) as Recording[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const update = useCallback(
    (id: string) => (f: TranscriptFields) =>
      setRecs((prev) => prev.map((r) => (r.id === id ? { ...r, ...f } : r))),
    [],
  );

  async function play(rec: Recording) {
    setLoadingId(rec.id);
    const { data, error } = await createClient()
      .storage.from(CALL_RECORDINGS_BUCKET)
      .createSignedUrl(rec.storage_path, SIGNED_URL_TTL_SECONDS);
    setLoadingId(null);
    if (error || !data) return toast.error(t("openFailed"));
    setPlayUrls((p) => ({ ...p, [rec.id]: data.signedUrl }));
  }

  if (!contactId || recs.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Mic className="h-3 w-3" />
        {t("contactRecordings", { count: recs.length })}
      </div>
      <ul className="space-y-2">
        {recs.map((rec) => (
          <li key={rec.id} className="rounded-lg bg-muted px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-xs text-muted-foreground">
                {[format(new Date(rec.created_at), "MMM d, HH:mm"), formatDuration(rec.duration_seconds)]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {!playUrls[rec.id] && (
                <button
                  type="button"
                  onClick={() => play(rec)}
                  aria-label={t("play")}
                  title={t("play")}
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  {loadingId === rec.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                </button>
              )}
            </div>
            {playUrls[rec.id] && (
              <audio
                src={playUrls[rec.id]}
                controls
                autoPlay
                className="mt-2 h-8 w-full"
                onError={() => toast.error(t("cantPlay"))}
              />
            )}
            <CallInsights
              recordingId={rec.id}
              fields={rec}
              canStart={rec.uploaded_by === user?.id}
              onChange={update(rec.id)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
