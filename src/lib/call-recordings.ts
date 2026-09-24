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
