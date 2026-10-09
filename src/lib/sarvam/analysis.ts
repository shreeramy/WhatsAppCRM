import type { TranscriptSegment } from './stt';

// AI analysis of a transcribed sales call, using Sarvam's chat model
// (same SARVAM_API_KEY). Reasoning is switched off: with it on, the
// model spends the whole token budget "thinking" and returns no JSON.

export type LeadQuality = 'hot' | 'warm' | 'cold';

export interface CallAnalysis {
  summary: string;
  lead_quality: LeadQuality;
  /** Which diarized speaker (1 or 2) is our agent. */
  agent_speaker: 1 | 2;
  customer_need: string;
  team_size: string | null;
  objections: string[];
  next_step: string;
  follow_up_needed: boolean;
  /** 0–10. */
  agent_score: number;
  agent_did_well: string[];
  agent_improve: string[];
}

const SYSTEM_PROMPT = `You analyse recorded sales calls for DSA Management, a CRM for loan DSAs (loan agents).
Plans: Individual ₹600/month; Team ₹1,397/month or ₹14,400/year. A free 15-minute demo is offered.
The call is between our sales agent and a lead, transcribed in Hindi/English (Hinglish) with two speakers.
Reply with ONLY one JSON object, no other text, written in English:
{
 "summary": "2-3 sentences: who the lead is and what happened",
 "lead_quality": "hot" | "warm" | "cold",
 "agent_speaker": 1 | 2,
 "customer_need": "what the lead wants, or why they don't need it",
 "team_size": "e.g. 'solo', '5 people', or null if not mentioned",
 "objections": ["each objection the lead raised"],
 "next_step": "the concrete next action for our agent",
 "follow_up_needed": true | false,
 "agent_score": 0-10 (did they qualify the lead, explain pricing/value, offer the demo, close with a clear next step),
 "agent_did_well": ["..."],
 "agent_improve": ["..."]
}`;

function formatConversation(segments: TranscriptSegment[], transcript: string): string {
  if (segments.length === 0) return transcript;
  return segments.map((s) => `Speaker ${s.speaker}: ${s.text}`).join('\n');
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

/** Pull the JSON object out of a model reply and normalise its fields. */
export function parseAnalysis(raw: string | null | undefined): CallAnalysis | null {
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const quality = String(j.lead_quality ?? '').toLowerCase();
  const score = Number(j.agent_score);
  return {
    summary: String(j.summary ?? '').trim(),
    lead_quality: (['hot', 'warm', 'cold'].includes(quality) ? quality : 'warm') as LeadQuality,
    agent_speaker: Number(j.agent_speaker) === 2 ? 2 : 1,
    customer_need: String(j.customer_need ?? '').trim(),
    team_size: j.team_size == null || j.team_size === '' ? null : String(j.team_size),
    objections: asStrings(j.objections),
    next_step: String(j.next_step ?? '').trim(),
    follow_up_needed: j.follow_up_needed === true,
    agent_score: Number.isFinite(score) ? Math.max(0, Math.min(10, Math.round(score))) : 0,
    agent_did_well: asStrings(j.agent_did_well),
    agent_improve: asStrings(j.agent_improve),
  };
}

export async function analyseCall(
  segments: TranscriptSegment[],
  transcript: string,
): Promise<CallAnalysis> {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('SARVAM_API_KEY is not set');
  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'api-subscription-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'sarvam-105b',
      reasoning_effort: null,
      temperature: 0.2,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: formatConversation(segments, transcript) },
      ],
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string | null } }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`Sarvam analysis failed (${res.status}): ${body.error?.message ?? 'unknown error'}`);
  const analysis = parseAnalysis(body.choices?.[0]?.message?.content);
  if (!analysis) throw new Error('The AI reply could not be read as an analysis');
  return analysis;
}
