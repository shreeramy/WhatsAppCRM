// Helpers for call-recording uploads (migration 046).

export const CALL_RECORDINGS_BUCKET = "call-recordings";
export const MAX_RECORDING_BYTES = 50 * 1024 * 1024;

// Phone recorders often hand the browser a file with an empty or odd
// MIME type (.m4a → "", .amr → "application/octet-stream"), so derive
// it from the extension; the bucket only accepts these audio types.
const EXTENSION_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  amr: "audio/amr",
  "3gp": "audio/3gpp",
  "3gpp": "audio/3gpp",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  webm: "audio/webm",
  wav: "audio/wav",
  flac: "audio/flac",
};

export const RECORDING_ACCEPT =
  "audio/*," + Object.keys(EXTENSION_MIME).map((e) => `.${e}`).join(",");

function extension(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i === -1 ? "" : fileName.slice(i + 1).toLowerCase();
}

/** Audio MIME type for an upload, or null if it isn't a supported recording. */
export function recordingMimeType(fileName: string, browserType: string): string | null {
  const fromExt = EXTENSION_MIME[extension(fileName)];
  if (fromExt) return fromExt;
  return browserType.startsWith("audio/") ? browserType : null;
}

/** Storage key: `account-<id>/deal-<id>/<timestamp>-<safe name>`. */
export function recordingStoragePath(
  accountId: string,
  dealId: string,
  fileName: string,
  now: number = Date.now(),
): string {
  const safe =
    fileName
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(-80) || "recording";
  return `account-${accountId}/deal-${dealId}/${now}-${safe}`;
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function formatBytes(bytes: number | null | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The other party's number from a phone recorder's file name, e.g.
 * "Call recording +91 98765 43210_250930_101500.m4a" or
 * "9876543210_20260930.mp3". Returns digits with the 91 country code
 * ("919876543210"), or null when no Indian mobile number is found.
 */
export function phoneFromRecordingName(fileName: string): string | null {
  const base = fileName.replace(/\.[^.]+$/, "");
  const m = /(?<!\d)(?:\+?91[\s-]?)?([6-9]\d{4})[\s-]?(\d{5})(?!\d)/.exec(base);
  return m ? `91${m[1]}${m[2]}` : null;
}

/** Storage key for a daily call log upload: `account-<id>/calls/<user>/<yyyy-mm-dd>/<ts>-<name>`. */
export function dailyRecordingPath(
  accountId: string,
  userId: string,
  callDate: string,
  fileName: string,
  now: number = Date.now(),
): string {
  const safe =
    fileName
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(-80) || "recording";
  return `account-${accountId}/calls/${userId}/${callDate}/${now}-${safe}`;
}

/** Best-effort duration in seconds, read in the browser (null for formats it can't decode, e.g. AMR). */
export function readAudioDuration(file: File): Promise<number | null> {
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
