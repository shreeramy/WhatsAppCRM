import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { CALL_RECORDINGS_BUCKET } from '@/lib/call-recordings';
import { analyseCall } from '@/lib/sarvam/analysis';
import { getTranscriptionResult, startTranscriptionJob } from '@/lib/sarvam/stt';

// Transcribe + analyse one call recording with Sarvam.
//
//   POST → start a transcription job (no-op if one is running or done,
//          unless ?retry=1)
//   GET  → poll; when Sarvam finishes, store the transcript, run the AI
//          analysis and store that too
//
// Runs as the signed-in user, so RLS decides access: agents can only
// touch recordings they uploaded, owners/admins any in the account.

export const maxDuration = 60;

const COLUMNS =
  'id, storage_path, file_name, mime_type, transcript_status, transcript_job_id, transcript, transcript_segments, transcript_language, transcript_error, analysis, transcribed_at';

type Ctx = { params: Promise<{ id: string }> };

function publicView(row: Record<string, unknown>) {
  const { storage_path: _p, transcript_job_id: _j, ...rest } = row;
  void _p;
  void _j;
  return rest;
}

export async function POST(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const retry = new URL(request.url).searchParams.get('retry') === '1';

    const { data: rec, error } = await ctx.supabase
      .from('call_recordings')
      .select(COLUMNS)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) throw error;
    if (!rec) return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    if (!retry && (rec.transcript_status === 'processing' || rec.transcript_status === 'done')) {
      return NextResponse.json(publicView(rec));
    }

    const { data: audio, error: dlErr } = await ctx.supabase.storage
      .from(CALL_RECORDINGS_BUCKET)
      .download(rec.storage_path as string);
    if (dlErr || !audio) throw new Error(`Couldn't read the recording file: ${dlErr?.message ?? 'missing'}`);

    let jobId: string;
    try {
      jobId = await startTranscriptionJob(
        await audio.arrayBuffer(),
        rec.file_name as string,
        (rec.mime_type as string) ?? audio.type,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[transcribe] start failed:', message);
      await ctx.supabase
        .from('call_recordings')
        .update({ transcript_status: 'failed', transcript_error: message })
        .eq('id', id);
      return NextResponse.json({ error: message }, { status: 502 });
    }

    const { data: updated, error: updErr } = await ctx.supabase
      .from('call_recordings')
      .update({
        transcript_status: 'processing',
        transcript_job_id: jobId,
        transcript_error: null,
        ...(retry ? { transcript: null, transcript_segments: null, analysis: null } : {}),
      })
      .eq('id', id)
      .select(COLUMNS)
      .single();
    if (updErr) throw updErr;
    return NextResponse.json(publicView(updated));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function GET(_request: Request, { params }: Ctx) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await params;

    const { data: rec, error } = await ctx.supabase
      .from('call_recordings')
      .select(COLUMNS)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) throw error;
    if (!rec) return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    if (rec.transcript_status !== 'processing' || !rec.transcript_job_id) {
      return NextResponse.json(publicView(rec));
    }

    const result = await getTranscriptionResult(rec.transcript_job_id as string);
    if (result.state === 'running') return NextResponse.json(publicView(rec));

    let patch: Record<string, unknown>;
    if (result.state === 'failed') {
      console.error('[transcribe] job failed:', result.error);
      patch = { transcript_status: 'failed', transcript_error: result.error };
    } else {
      // Keep the transcript even if the analysis step fails.
      let analysis = null;
      let analysisError: string | null = null;
      if (result.transcript) {
        try {
          analysis = await analyseCall(result.segments, result.transcript);
        } catch (err) {
          analysisError = err instanceof Error ? err.message : String(err);
          console.error('[transcribe] analysis failed:', analysisError);
        }
      }
      patch = {
        transcript_status: 'done',
        transcript: result.transcript || null,
        transcript_segments: result.segments,
        transcript_language: result.language,
        analysis,
        transcript_error: result.transcript ? analysisError : 'No speech found in this recording',
        transcribed_at: new Date().toISOString(),
      };
    }

    // Only the first poller to finish writes (concurrent polls are harmless).
    const { data: updated } = await ctx.supabase
      .from('call_recordings')
      .update(patch)
      .eq('id', id)
      .eq('transcript_status', 'processing')
      .select(COLUMNS)
      .maybeSingle();
    return NextResponse.json(publicView(updated ?? { ...rec, ...patch }));
  } catch (error) {
    return toErrorResponse(error);
  }
}
