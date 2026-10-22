/**
 * Retry every call recording whose transcript failed (e.g. Sarvam ran out
 * of credits): start a new Sarvam job for each, then poll until done and
 * store transcript + analysis, exactly like /api/calls/[id]/transcribe.
 *
 *   npx tsx scripts/retry-failed-transcripts.mts [--limit 50]
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { getTranscriptionResult, startTranscriptionJob } from "../src/lib/sarvam/stt";
import { analyseCall } from "../src/lib/sarvam/analysis";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
process.env.SARVAM_API_KEY ??= env.SARVAM_API_KEY;
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const LIMIT = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : 1000;

async function main() {
  const { data: failed } = await db
    .from("call_recordings")
    .select("id, storage_path, file_name, mime_type")
    // --never-started: recordings that were never transcribed (status null).
    .filter("transcript_status", argv.includes("--never-started") ? "is" : "eq", argv.includes("--never-started") ? null : "failed")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  console.log(`failed recordings: ${failed?.length ?? 0}`);

  let started = 0;
  for (const rec of failed ?? []) {
    try {
      const { data: audio, error } = await db.storage.from("call-recordings").download(rec.storage_path);
      if (error || !audio) throw new Error(`download: ${error?.message ?? "missing"}`);
      const jobId = await startTranscriptionJob(await audio.arrayBuffer(), rec.file_name, rec.mime_type ?? audio.type);
      await db
        .from("call_recordings")
        .update({ transcript_status: "processing", transcript_job_id: jobId, transcript_error: null, transcript: null, transcript_segments: null, analysis: null })
        .eq("id", rec.id);
      started++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`start failed ${rec.id}: ${msg}`);
      await db.from("call_recordings").update({ transcript_error: msg }).eq("id", rec.id);
      if (/402|credit/i.test(msg)) {
        console.log("Sarvam says no credits — stopping.");
        break;
      }
    }
    await sleep(2500);
  }
  console.log(`started: ${started}`);

  // Poll every processing job until it finishes (max ~45 min).
  for (let round = 0; round < 180; round++) {
    const { data: open } = await db
      .from("call_recordings")
      .select("id, transcript_job_id")
      .eq("transcript_status", "processing")
      .not("transcript_job_id", "is", null);
    if (!open?.length) break;
    for (const rec of open) {
      const result = await getTranscriptionResult(rec.transcript_job_id!);
      if (result.state === "running") continue;
      let patch: Record<string, unknown>;
      if (result.state === "failed") {
        patch = { transcript_status: "failed", transcript_error: result.error };
      } else {
        let analysis = null;
        let analysisError: string | null = null;
        if (result.transcript) {
          try {
            analysis = await analyseCall(result.segments, result.transcript);
          } catch (err) {
            analysisError = err instanceof Error ? err.message : String(err);
          }
        }
        patch = {
          transcript_status: "done",
          transcript: result.transcript || null,
          transcript_segments: result.segments,
          transcript_language: result.language,
          analysis,
          transcript_error: result.transcript ? analysisError : "No speech found in this recording",
          transcribed_at: new Date().toISOString(),
        };
      }
      await db.from("call_recordings").update(patch).eq("id", rec.id).eq("transcript_status", "processing");
    }
    const { data: counts } = await db.from("call_recordings").select("transcript_status");
    const by: Record<string, number> = {};
    for (const c of counts ?? []) by[String(c.transcript_status)] = (by[String(c.transcript_status)] ?? 0) + 1;
    console.log(`round ${round}: ${JSON.stringify(by)}`);
    await sleep(15000);
  }
}
main();
