import { describe, expect, it } from "vitest";
import { summarizeCallAnalyses } from "./team";

describe("summarizeCallAnalyses", () => {
  it("counts lead quality and averages the agent score over analysed calls only", () => {
    expect(
      summarizeCallAnalyses([
        { lead_quality: "hot", agent_score: "8" },
        { lead_quality: "cold", agent_score: 2 },
        { lead_quality: "warm", agent_score: "7" },
        { lead_quality: null, agent_score: null }, // not transcribed yet
      ]),
    ).toEqual({ callsAnalysed: 3, avgCallScore: 5.7, hotLeads: 1, warmLeads: 1, coldLeads: 1 });
  });

  it("returns a null average when nothing is analysed", () => {
    expect(summarizeCallAnalyses([{ lead_quality: null, agent_score: null }])).toEqual({
      callsAnalysed: 0,
      avgCallScore: null,
      hotLeads: 0,
      warmLeads: 0,
      coldLeads: 0,
    });
  });
});
