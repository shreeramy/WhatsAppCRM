"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import {
  CheckCircle2,
  Download,
  Loader2,
  Mic,
  Play,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateRangeFilter } from "@/components/ui/date-range-filter";
import { resolveRange, type DateRangeValue } from "@/lib/date-range";
import { formatPhoneDisplay } from "@/lib/whatsapp/phone-utils";
import {
  CallInsights,
  requestTranscription,
  type TranscriptFields,
} from "@/components/calls/call-insights";
import {
  CALL_RECORDINGS_BUCKET,
  MAX_RECORDING_BYTES,
  RECORDING_ACCEPT,
  dailyRecordingPath,
  formatBytes,
  formatDuration,
  phoneFromRecordingName,
  readAudioDuration,
  recordingMimeType,
} from "@/lib/call-recordings";

interface Recording {
  id: string;
  storage_path: string;
  file_name: string;
  size_bytes: number | null;
  duration_seconds: number | null;
  notes: string | null;
  phone: string | null;
  contact_id: string | null;
  deal_id: string | null;
  uploaded_by: string | null;
  call_date: string;
  created_at: string;
}

type RecordingRow = Recording & TranscriptFields;

type UploadStatus = "pending" | "uploading" | "done" | "error";
interface QueueItem {
  key: string;
  file: File;
  status: UploadStatus;
  error?: string;
}

const SIGNED_URL_TTL_SECONDS = 60 * 60;
const UPLOAD_CONCURRENCY = 2;
const LIST_LIMIT = 2000;

const todayStr = () => format(new Date(), "yyyy-MM-dd");

export default function CallRecordingsPage() {
  const t = useTranslations("Calls");
  const { user, accountId, canSendMessages, canManageMembers } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);

  // ---- upload ------------------------------------------------------
  const [callDate, setCallDate] = useState(todayStr);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // ---- list --------------------------------------------------------
  const [range, setRange] = useState<DateRangeValue>({ preset: "last7" });
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [items, setItems] = useState<RecordingRow[] | null>(null);
  const [members, setMembers] = useState<Map<string, string>>(new Map());
  const [contactNames, setContactNames] = useState<Map<string, string>>(new Map());
  const [dealTitles, setDealTitles] = useState<Map<string, string>>(new Map());
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const r = resolveRange(range);
    let q = supabase
      .from("call_recordings")
      .select(
        "id, storage_path, file_name, size_bytes, duration_seconds, notes, phone, contact_id, deal_id, uploaded_by, call_date, created_at, transcript_status, transcript, transcript_segments, transcript_error, analysis",
      )
      .eq("account_id", accountId)
      .order("call_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT);
    if (r.from) q = q.gte("call_date", format(r.from, "yyyy-MM-dd"));
    if (r.to) q = q.lte("call_date", format(r.to, "yyyy-MM-dd"));
    if (agentFilter !== "all") q = q.eq("uploaded_by", agentFilter);

    const [recs, profs] = await Promise.all([
      q,
      supabase.from("profiles").select("user_id, full_name, email").eq("account_id", accountId),
    ]);
    if (recs.error) {
      toast.error(t("loadFailed"));
      setItems([]);
      return;
    }
    const rows = (recs.data ?? []) as RecordingRow[];
    setItems(rows);
    setMembers(
      new Map(
        (profs.data ?? []).map((p) => [
          p.user_id as string,
          (p.full_name as string) || (p.email as string) || "—",
        ]),
      ),
    );

    const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))] as string[];
    const dealIds = [...new Set(rows.map((r) => r.deal_id).filter(Boolean))] as string[];
    const [contacts, deals] = await Promise.all([
      contactIds.length
        ? supabase.from("contacts").select("id, name, phone").in("id", contactIds)
        : Promise.resolve({ data: [] }),
      dealIds.length
        ? supabase.from("deals").select("id, title").in("id", dealIds)
        : Promise.resolve({ data: [] }),
    ]);
    setContactNames(
      new Map(
        (contacts.data ?? []).map((c) => [
          c.id as string,
          (c.name as string) || formatPhoneDisplay(c.phone as string),
        ]),
      ),
    );
    setDealTitles(new Map((deals.data ?? []).map((d) => [d.id as string, d.title as string])));
  }, [accountId, range, agentFilter, t]);

  useEffect(() => {
    load();
  }, [load]);

  // ---- bulk upload -------------------------------------------------
  function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setQueue((prev) => [
      ...prev.filter((q) => q.status !== "done"),
      ...list.map((file, i) => ({
        key: `${Date.now()}-${i}-${file.name}`,
        file,
        status: "pending" as const,
      })),
    ]);
  }

  async function uploadAll() {
    if (!accountId || !user) {
      toast.error(t("notLinked"));
      return;
    }
    const pending = queue.filter((q) => q.status === "pending" || q.status === "error");
    if (pending.length === 0) return;
    setUploading(true);
    const supabase = createClient();

    // Match numbers in file names to contacts in one query.
    const phones = [
      ...new Set(pending.map((q) => phoneFromRecordingName(q.file.name)).filter(Boolean)),
    ] as string[];
    const contactByPhone = new Map<string, string>();
    if (phones.length) {
      const { data } = await supabase
        .from("contacts")
        .select("id, phone_normalized")
        .eq("account_id", accountId)
        .in("phone_normalized", phones);
      for (const c of data ?? []) contactByPhone.set(c.phone_normalized as string, c.id as string);
    }

    const setStatus = (key: string, status: UploadStatus, error?: string) =>
      setQueue((prev) => prev.map((q) => (q.key === key ? { ...q, status, error } : q)));

    let ok = 0;
    let failed = 0;
    const work = [...pending];

    async function uploadOne(item: QueueItem) {
      const { file } = item;
      const mime = recordingMimeType(file.name, file.type);
      if (!mime) {
        failed++;
        return setStatus(item.key, "error", t("notAudio"));
      }
      if (file.size > MAX_RECORDING_BYTES) {
        failed++;
        return setStatus(item.key, "error", t("tooLarge"));
      }
      setStatus(item.key, "uploading");
      const path = dailyRecordingPath(accountId!, user!.id, callDate, file.name);
      const typed = file.type === mime ? file : new File([file], file.name, { type: mime });
      const [duration, up] = await Promise.all([
        readAudioDuration(file),
        supabase.storage.from(CALL_RECORDINGS_BUCKET).upload(path, typed, {
          contentType: mime,
          upsert: false,
        }),
      ]);
      if (up.error) {
        failed++;
        return setStatus(item.key, "error", t("uploadFailed"));
      }
      const phone = phoneFromRecordingName(file.name);
      const { error } = await supabase.from("call_recordings").insert({
        account_id: accountId,
        uploaded_by: user!.id,
        call_date: callDate,
        storage_path: path,
        file_name: file.name,
        mime_type: mime,
        size_bytes: file.size,
        duration_seconds: duration,
        phone,
        contact_id: phone ? contactByPhone.get(phone) ?? null : null,
      });
      if (error) {
        await supabase.storage.from(CALL_RECORDINGS_BUCKET).remove([path]);
        failed++;
        return setStatus(item.key, "error", t("uploadFailed"));
      }
      ok++;
      setStatus(item.key, "done");
    }

    await Promise.all(
      Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
        for (let item = work.shift(); item; item = work.shift()) await uploadOne(item);
      }),
    );

    setUploading(false);
    if (ok) toast.success(t("uploadedCount", { count: ok }));
    if (failed) toast.error(t("failedCount", { count: failed }));
    load();
  }

  // ---- playback / delete -------------------------------------------
  async function signedUrl(rec: Recording, download: boolean) {
    const { data, error } = await createClient()
      .storage.from(CALL_RECORDINGS_BUCKET)
      .createSignedUrl(
        rec.storage_path,
        SIGNED_URL_TTL_SECONDS,
        download ? { download: rec.file_name } : undefined,
      );
    if (error || !data) {
      toast.error(t("openFailed"));
      return null;
    }
    return data.signedUrl;
  }

  async function play(rec: Recording) {
    setLoadingId(rec.id);
    const url = await signedUrl(rec, false);
    setLoadingId(null);
    if (url) setPlayUrls((p) => ({ ...p, [rec.id]: url }));
  }

  async function remove(rec: Recording) {
    if (!window.confirm(t("deleteConfirm"))) return;
    const supabase = createClient();
    const { data: removed, error: fileErr } = await supabase.storage
      .from(CALL_RECORDINGS_BUCKET)
      .remove([rec.storage_path]);
    if (fileErr || !removed?.length) {
      toast.error(t("deleteFailed"));
      return;
    }
    const { error } = await supabase.from("call_recordings").delete().eq("id", rec.id);
    if (error) {
      toast.error(t("deleteFailed"));
      return;
    }
    setItems((prev) => prev?.filter((r) => r.id !== rec.id) ?? prev);
    toast.success(t("deleted"));
  }

  // ---- transcription ---------------------------------------------
  const [bulkBusy, setBulkBusy] = useState(false);

  const updateTranscript = useCallback(
    (id: string) => (f: TranscriptFields) =>
      setItems((prev) => prev?.map((r) => (r.id === id ? { ...r, ...f } : r)) ?? prev),
    [],
  );

  async function transcribeAll(recs: RecordingRow[]) {
    const todo = recs.filter(
      (r) => !r.transcript_status && (canManageMembers || r.uploaded_by === user?.id),
    );
    setBulkBusy(true);
    let failed = 0;
    for (const r of todo) {
      try {
        updateTranscript(r.id)(await requestTranscription(r.id, "POST"));
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    if (failed) toast.error(t("insights.someFailed", { count: failed }));
  }

  // ---- grouping: day → agent ---------------------------------------
  const grouped = useMemo(() => {
    const days = new Map<string, Map<string, RecordingRow[]>>();
    for (const r of items ?? []) {
      const byAgent = days.get(r.call_date) ?? new Map<string, RecordingRow[]>();
      const key = r.uploaded_by ?? "unknown";
      byAgent.set(key, [...(byAgent.get(key) ?? []), r]);
      days.set(r.call_date, byAgent);
    }
    return [...days.entries()];
  }, [items]);

  const totalSeconds = (rs: RecordingRow[]) =>
    rs.reduce((s, r) => s + (r.duration_seconds ?? 0), 0);

  const pendingCount = queue.filter((q) => q.status === "pending" || q.status === "error").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {canManageMembers ? t("descriptionManager") : t("descriptionAgent")}
        </p>
      </div>

      {/* Bulk upload */}
      {canSendMessages && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("callDate")}</span>
              <Input
                type="date"
                value={callDate}
                max={todayStr()}
                onChange={(e) => setCallDate(e.target.value || todayStr())}
                className="h-9 w-44 border-border bg-muted text-foreground"
              />
            </label>
            <p className="pb-2 text-xs text-muted-foreground">{t("callDateHint")}</p>
          </div>

          <input
            ref={fileInput}
            type="file"
            multiple
            accept={RECORDING_ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              addFiles(e.dataTransfer.files);
            }}
            className={cn(
              "flex w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-sm transition-colors",
              dragOver
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
            )}
          >
            <Upload className="h-5 w-5" />
            <span className="font-medium">{t("dropHere")}</span>
            <span className="text-xs">{t("formats")}</span>
          </button>

          {queue.length > 0 && (
            <div className="space-y-2">
              <ul className="max-h-56 space-y-1 overflow-y-auto">
                {queue.map((q) => (
                  <li
                    key={q.key}
                    className="flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1 text-xs"
                  >
                    {q.status === "uploading" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    ) : q.status === "done" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                    ) : q.status === "error" ? (
                      <XCircle className="h-3.5 w-3.5 text-red-400" />
                    ) : (
                      <Mic className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate text-foreground">{q.file.name}</span>
                    {q.error && <span className="text-red-400">{q.error}</span>}
                    <span className="text-muted-foreground">{formatBytes(q.file.size)}</span>
                    {q.status !== "uploading" && !uploading && (
                      <button
                        type="button"
                        onClick={() => setQueue((prev) => prev.filter((x) => x.key !== q.key))}
                        aria-label={t("removeFromList")}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <Button onClick={uploadAll} disabled={uploading || pendingCount === 0}>
                  {uploading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {uploading ? t("uploading") : t("uploadCount", { count: pendingCount })}
                </Button>
                {!uploading && (
                  <Button variant="ghost" onClick={() => setQueue([])}>
                    {t("clearList")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <DateRangeFilter value={range} onChange={setRange} label={t("filterDate")} />
        {canManageMembers && (
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            aria-label={t("filterAgent")}
            className="h-8 rounded-lg border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary"
          >
            <option value="all">{t("allAgents")}</option>
            {[...members.entries()]
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
          </select>
        )}
        {items && (
          <span className="text-xs text-muted-foreground">
            {t("summary", {
              count: items.length,
              duration: formatDuration(totalSeconds(items)) ?? "0:00",
            })}
          </span>
        )}
      </div>

      {/* Day → agent → recordings */}
      {items === null ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : grouped.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/40">
          <Mic className="h-6 w-6 text-primary" />
          <p className="mt-2 text-sm font-medium text-foreground">{t("empty")}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([day, byAgent]) => {
            const dayRecs = [...byAgent.values()].flat();
            return (
              <section key={day} className="space-y-3">
                <h2 className="flex items-baseline gap-2 border-b border-border pb-1 text-sm font-semibold text-foreground">
                  {format(new Date(`${day}T12:00:00`), "EEEE, d MMM yyyy")}
                  <span className="text-xs font-normal text-muted-foreground">
                    {t("groupSummary", {
                      count: dayRecs.length,
                      duration: formatDuration(totalSeconds(dayRecs)) ?? "0:00",
                    })}
                  </span>
                </h2>
                {[...byAgent.entries()].map(([agentId, recs]) => (
                  <div key={agentId} className="rounded-xl border border-border bg-card">
                    <div className="flex items-center justify-between border-b border-border px-3 py-2">
                      <span className="text-sm font-medium text-foreground">
                        {members.get(agentId) ?? t("unknownAgent")}
                      </span>
                      <span className="flex items-center gap-3 text-xs text-muted-foreground">
                        {canSendMessages &&
                          recs.some((r) => !r.transcript_status && (canManageMembers || r.uploaded_by === user?.id)) && (
                            <button
                              type="button"
                              onClick={() => transcribeAll(recs)}
                              disabled={bulkBusy}
                              className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-60"
                            >
                              {bulkBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                              {t("insights.transcribeAll", {
                                count: recs.filter((r) => !r.transcript_status && (canManageMembers || r.uploaded_by === user?.id)).length,
                              })}
                            </button>
                          )}
                        {t("groupSummary", {
                          count: recs.length,
                          duration: formatDuration(totalSeconds(recs)) ?? "0:00",
                        })}
                      </span>
                    </div>
                    <ul className="divide-y divide-border">
                      {recs.map((rec) => {
                        const who =
                          (rec.contact_id && contactNames.get(rec.contact_id)) ||
                          (rec.phone ? formatPhoneDisplay(rec.phone) : null);
                        const meta = [
                          format(new Date(rec.created_at), "HH:mm"),
                          formatDuration(rec.duration_seconds),
                          formatBytes(rec.size_bytes),
                          rec.deal_id ? `${t("deal")}: ${dealTitles.get(rec.deal_id) ?? "—"}` : null,
                        ].filter(Boolean);
                        const canDelete =
                          canSendMessages && (canManageMembers || rec.uploaded_by === user?.id);
                        return (
                          <li key={rec.id} className="px-3 py-2">
                            <div className="flex items-start gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm text-foreground">
                                  {who ? (
                                    <>
                                      <span className="font-medium">{who}</span>
                                      <span className="text-muted-foreground"> · {rec.file_name}</span>
                                    </>
                                  ) : (
                                    rec.file_name
                                  )}
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                  {t("uploadedAt")} {meta.join(" · ")}
                                </p>
                                {rec.notes && (
                                  <p className="mt-0.5 text-xs text-muted-foreground">{rec.notes}</p>
                                )}
                              </div>
                              <div className="flex shrink-0 items-center gap-0.5">
                                {!playUrls[rec.id] && (
                                  <button
                                    type="button"
                                    onClick={() => play(rec)}
                                    aria-label={t("play")}
                                    title={t("play")}
                                    className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                  >
                                    {loadingId === rec.id ? (
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                      <Play className="h-4 w-4" />
                                    )}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={async () => {
                                    const url = await signedUrl(rec, true);
                                    if (url) window.location.assign(url);
                                  }}
                                  aria-label={t("download")}
                                  title={t("download")}
                                  className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                >
                                  <Download className="h-4 w-4" />
                                </button>
                                {canDelete && (
                                  <button
                                    type="button"
                                    onClick={() => remove(rec)}
                                    aria-label={t("delete")}
                                    title={t("delete")}
                                    className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-red-400"
                                  >
                                    <Trash2 className="h-4 w-4" />
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
                            <CallInsights
                              recordingId={rec.id}
                              fields={rec}
                              canStart={canDelete}
                              onChange={updateTranscript(rec.id)}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
