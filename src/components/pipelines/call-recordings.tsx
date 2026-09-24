"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { Download, Loader2, Mic, Play, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Profile } from "@/types";
import { Input } from "@/components/ui/input";
import {
  CALL_RECORDINGS_BUCKET,
  MAX_RECORDING_BYTES,
  RECORDING_ACCEPT,
  formatBytes,
  formatDuration,
  recordingMimeType,
  recordingStoragePath,
} from "@/lib/call-recordings";

interface CallRecording {
  id: string;
  deal_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  notes: string | null;
  uploaded_by: string | null;
  created_at: string;
}

interface CallRecordingsProps {
  dealId: string;
  contactId: string | null;
}

/** Signed playback links last this long; refetched on the next play. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Best-effort duration from the file itself (null for formats the browser can't decode, e.g. AMR). */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 5000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(audio.duration) ? Math.round(audio.duration) : null);
    };
    audio.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    audio.src = url;
  });
}

export function CallRecordings({ dealId, contactId }: CallRecordingsProps) {
  const t = useTranslations("CallRecordings");
  const { user, accountId, canSendMessages, canManageMembers } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<CallRecording[] | null>(null);
  const [members, setMembers] = useState<Map<string, string>>(new Map());
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [recs, profs] = await Promise.all([
      supabase
        .from("call_recordings")
        .select("*")
        .eq("deal_id", dealId)
        .order("created_at", { ascending: false }),
      accountId
        ? supabase.from("profiles").select("user_id, full_name, email").eq("account_id", accountId)
        : Promise.resolve({ data: [] }),
    ]);
    setItems(recs.error ? [] : ((recs.data ?? []) as CallRecording[]));
    setMembers(
      new Map(
        ((profs.data ?? []) as Pick<Profile, "user_id" | "full_name" | "email">[]).map((p) => [
          p.user_id,
          p.full_name || p.email,
        ]),
      ),
    );
  }, [dealId, accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function handleFile(file: File) {
    if (!accountId || !user) {
      toast.error(t("notLinked"));
      return;
    }
    const mime = recordingMimeType(file.name, file.type);
    if (!mime) {
      toast.error(t("notAudio"));
      return;
    }
    if (file.size > MAX_RECORDING_BYTES) {
      toast.error(t("tooLarge"));
      return;
    }

    setUploading(true);
    const supabase = createClient();
    const path = recordingStoragePath(accountId, dealId, file.name);
    const duration = await readDuration(file);

    // storage-js takes a File's own type over `contentType`, and phone
    // recordings often arrive untyped — so re-wrap it with the right one.
    const typed = file.type === mime ? file : new File([file], file.name, { type: mime });
    const { error: upErr } = await supabase.storage
      .from(CALL_RECORDINGS_BUCKET)
      .upload(path, typed, { contentType: mime, upsert: false });
    if (upErr) {
      console.error("Recording upload failed:", upErr.message);
      toast.error(t("uploadFailed"));
      setUploading(false);
      return;
    }

    const { error: rowErr } = await supabase.from("call_recordings").insert({
      account_id: accountId,
      deal_id: dealId,
      contact_id: contactId,
      storage_path: path,
      file_name: file.name,
      mime_type: mime,
      size_bytes: file.size,
      duration_seconds: duration,
      notes: note.trim() || null,
      uploaded_by: user.id,
    });
    if (rowErr) {
      // Don't leave an orphaned file behind.
      await supabase.storage.from(CALL_RECORDINGS_BUCKET).remove([path]);
      console.error("Recording save failed:", rowErr.message);
      toast.error(t("uploadFailed"));
      setUploading(false);
      return;
    }

    setUploading(false);
    setNote("");
    toast.success(t("uploaded"));
    load();
  }

  async function signedUrl(rec: CallRecording, download: boolean): Promise<string | null> {
    const { data, error } = await createClient()
      .storage.from(CALL_RECORDINGS_BUCKET)
      .createSignedUrl(rec.storage_path, SIGNED_URL_TTL_SECONDS, download ? { download: rec.file_name } : undefined);
    if (error || !data) {
      toast.error(t("loadFailed"));
      return null;
    }
    return data.signedUrl;
  }

  async function play(rec: CallRecording) {
    setLoadingId(rec.id);
    const url = await signedUrl(rec, false);
    setLoadingId(null);
    if (url) setPlayUrls((prev) => ({ ...prev, [rec.id]: url }));
  }

  async function download(rec: CallRecording) {
    const url = await signedUrl(rec, true);
    if (url) window.location.assign(url);
  }

  async function remove(rec: CallRecording) {
    if (!window.confirm(t("deleteConfirm"))) return;
    const supabase = createClient();
    // File first: its delete policy checks the row still exists.
    const { data: removed, error: fileErr } = await supabase.storage
      .from(CALL_RECORDINGS_BUCKET)
      .remove([rec.storage_path]);
    // A policy-blocked delete comes back as success with nothing removed.
    const blocked = fileErr || !removed?.length;
    const { error: rowErr } = blocked
      ? { error: fileErr ?? new Error("not permitted") }
      : await supabase.from("call_recordings").delete().eq("id", rec.id);
    if (rowErr) {
      toast.error(t("deleteFailed"));
      return;
    }
    setItems((prev) => prev?.filter((r) => r.id !== rec.id) ?? prev);
    toast.success(t("deleted"));
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/50 p-3">
      <div className="flex items-center gap-2">
        <Mic className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="flex-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("title")}
        </p>
      </div>

      {canSendMessages && (
        <div className="space-y-1.5">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("notePlaceholder")}
            className="h-8 border-border bg-muted text-xs text-foreground"
          />
          <input
            ref={fileInput}
            type="file"
            accept={RECORDING_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) handleFile(f);
            }}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:border-primary/50 hover:text-foreground disabled:opacity-60"
          >
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {uploading ? t("uploading") : t("upload")}
          </button>
          <p className="text-[10px] text-muted-foreground">{t("hint")}</p>
        </div>
      )}

      {items === null ? (
        <div className="flex justify-center py-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((rec) => {
            const canDelete =
              canSendMessages && (canManageMembers || rec.uploaded_by === user?.id);
            const meta = [
              format(new Date(rec.created_at), "d MMM yyyy, HH:mm"),
              rec.uploaded_by ? members.get(rec.uploaded_by) : null,
              formatDuration(rec.duration_seconds),
              formatBytes(rec.size_bytes),
            ].filter(Boolean);
            return (
              <li key={rec.id} className="rounded-lg border border-border bg-card p-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground" title={rec.file_name}>
                      {rec.file_name}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{meta.join(" · ")}</p>
                    {rec.notes && (
                      <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{rec.notes}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {!playUrls[rec.id] && (
                      <button
                        type="button"
                        onClick={() => play(rec)}
                        aria-label={t("play")}
                        title={t("play")}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {loadingId === rec.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => download(rec)}
                      aria-label={t("download")}
                      title={t("download")}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => remove(rec)}
                        aria-label={t("delete")}
                        title={t("delete")}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
