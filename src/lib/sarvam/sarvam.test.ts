import { describe, expect, it } from 'vitest';
import { parseAnalysis } from './analysis';
import { toSegments } from './stt';

describe('toSegments', () => {
  it('turns Sarvam diarized entries into 1-based speaker turns', () => {
    expect(
      toSegments({
        diarized_transcript: {
          entries: [
            { transcript: 'आपने CRM के लिए inquiry की थी', start_time_seconds: 0.01, end_time_seconds: 2.51, speaker_id: '0' },
            { transcript: '  ', start_time_seconds: 3, end_time_seconds: 3.2, speaker_id: '1' },
            { transcript: 'कहाँ से', start_time_seconds: 3.93, end_time_seconds: 4.65, speaker_id: '1' },
          ],
        },
      }),
    ).toEqual([
      { speaker: 1, start: 0, end: 2.5, text: 'आपने CRM के लिए inquiry की थी' },
      { speaker: 2, start: 3.9, end: 4.7, text: 'कहाँ से' },
    ]);
  });

  it('handles output without diarization', () => {
    expect(toSegments({ transcript: 'hello' })).toEqual([]);
  });
});

describe('parseAnalysis', () => {
  it('reads a JSON reply, even with prose or fences around it', () => {
    const raw =
      'Here you go:\n```json\n{"summary":"Lead is a BSNL employee, not a DSA.","lead_quality":"Cold","agent_speaker":1,' +
      '"customer_need":"None","objections":["Not a DSA"],"next_step":"Mark unqualified","follow_up_needed":false,' +
      '"agent_score":2.4,"agent_did_well":["Polite"],"agent_improve":["Qualify earlier"]}\n```';
    expect(parseAnalysis(raw)).toEqual({
      summary: 'Lead is a BSNL employee, not a DSA.',
      lead_quality: 'cold',
      agent_speaker: 1,
      customer_need: 'None',
      team_size: null,
      objections: ['Not a DSA'],
      next_step: 'Mark unqualified',
      follow_up_needed: false,
      agent_score: 2,
      agent_did_well: ['Polite'],
      agent_improve: ['Qualify earlier'],
    });
  });

  it('clamps scores and fixes bad values', () => {
    const a = parseAnalysis('{"lead_quality":"maybe","agent_speaker":"2","agent_score":42,"objections":"price"}');
    expect(a).toMatchObject({ lead_quality: 'warm', agent_speaker: 2, agent_score: 10, objections: [] });
  });

  it('returns null when there is no JSON', () => {
    expect(parseAnalysis('Sorry, I cannot help')).toBeNull();
    expect(parseAnalysis(null)).toBeNull();
    expect(parseAnalysis('{not json}')).toBeNull();
  });
});
