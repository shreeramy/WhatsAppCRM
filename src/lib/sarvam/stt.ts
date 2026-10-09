// Sarvam batch speech-to-text (server-only). Phone calls run longer
// than the 30-second limit of the plain REST endpoint, so this uses the
// job API: create → get upload URL → PUT file → start → poll → download.
// Endpoints mirror the official `sarvamai` SDK (speech_to_text_job).

const BASE = 'https://api.sarvam.ai';

export interface TranscriptSegment {
  /** 1-based speaker number from diarization. */
  speaker: number;
  start: number;
  end: number;
  text: string;
}

export type JobResult =
  | { state: 'running' }
  | { state: 'failed'; error: string }
  | { state: 'done'; transcript: string; segments: TranscriptSegment[]; language: string | null };

function apiKey(): string {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('SARVAM_API_KEY is not set');
  return key;
}

async function call<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: { 'api-subscription-key': apiKey(), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // not JSON — keep the raw text
    }
    throw new Error(`Sarvam ${path.split('/').slice(-1)[0]} failed (${res.status}): ${message}`);
  }
  return JSON.parse(text) as T;
}

/** Start a diarized, code-mixed (Hinglish-friendly) transcription job. */
export async function startTranscriptionJob(
  audio: ArrayBuffer,
  fileName: string,
  mimeType: string,
): Promise<string> {
  const init = await call<{ job_id: string }>('speech-to-text/job/v1', 'POST', {
    job_parameters: {
      model: 'saaras:v3',
      // English words stay in English inside Hindi speech ("CRM", "demo").
      mode: 'codemix',
      language_code: 'unknown',
      with_diarization: true,
      num_speakers: 2,
    },
  });

  const ext = fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? '.mp3';
  const name = `call${ext.toLowerCase()}`;
  const upload = await call<{ upload_urls: Record<string, { file_url: string }> }>(
    'speech-to-text/job/v1/upload-files',
    'POST',
    { job_id: init.job_id, files: [name] },
  );
  const url = upload.upload_urls[name]?.file_url;
  if (!url) throw new Error('Sarvam did not return an upload URL');
  const put = await fetch(url, {
    method: 'PUT',
    headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': mimeType || 'audio/mpeg' },
    body: audio,
  });
  if (!put.ok) throw new Error(`Uploading audio to Sarvam failed (${put.status})`);

  await call(`speech-to-text/job/v1/${init.job_id}/start`, 'POST');
  return init.job_id;
}

interface JobStatus {
  job_state: 'Accepted' | 'Pending' | 'Running' | 'Completed' | 'Failed';
  error_message?: string | null;
  job_details?: {
    state?: string;
    error_message?: string | null;
    outputs?: { file_name: string }[];
  }[];
}

interface SarvamOutput {
  transcript?: string;
  language_code?: string | null;
  diarized_transcript?: {
    entries?: {
      transcript: string;
      start_time_seconds: number;
      end_time_seconds: number;
      speaker_id: string;
    }[];
  } | null;
}

export function toSegments(out: SarvamOutput): TranscriptSegment[] {
  return (out.diarized_transcript?.entries ?? [])
    .filter((e) => e.transcript?.trim())
    .map((e) => ({
      speaker: (Number.parseInt(e.speaker_id, 10) || 0) + 1,
      start: Math.round(e.start_time_seconds * 10) / 10,
      end: Math.round(e.end_time_seconds * 10) / 10,
      text: e.transcript.trim(),
    }));
}

/** Check a job; when finished, download and normalise its transcript. */
export async function getTranscriptionResult(jobId: string): Promise<JobResult> {
  const status = await call<JobStatus>(`speech-to-text/job/v1/${jobId}/status`, 'GET');
  if (status.job_state === 'Failed') {
    return { state: 'failed', error: status.error_message || status.job_details?.[0]?.error_message || 'Transcription failed' };
  }
  if (status.job_state !== 'Completed') return { state: 'running' };

  const detail = status.job_details?.[0];
  const outName = detail?.outputs?.[0]?.file_name;
  if (!outName || detail?.state === 'Failed') {
    return { state: 'failed', error: detail?.error_message || 'Sarvam returned no transcript (unsupported or silent audio?)' };
  }
  const dl = await call<{ download_urls: Record<string, { file_url: string }> }>(
    'speech-to-text/job/v1/download-files',
    'POST',
    { job_id: jobId, files: [outName] },
  );
  const fileUrl = dl.download_urls[outName]?.file_url;
  if (!fileUrl) return { state: 'failed', error: 'Sarvam did not return a download URL' };
  const out = (await (await fetch(fileUrl)).json()) as SarvamOutput;
  const segments = toSegments(out);
  return {
    state: 'done',
    transcript: (out.transcript ?? segments.map((s) => s.text).join(' ')).trim(),
    segments,
    language: out.language_code ?? null,
  };
}
