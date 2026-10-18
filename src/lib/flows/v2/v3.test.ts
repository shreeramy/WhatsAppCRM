import { describe, expect, it } from "vitest";
import {
  agentNameFor,
  canSendNudge,
  computeListSlots,
  demoReminderDue,
  pauseBlocks,
  shiftOutOfQuietHours,
  slotRange,
  tagMatches,
  type ListSlotConfig,
} from "./v3";
import { pickBundle, type V2Bundle, type V2Settings, type WorkingHours } from "./settings";

const TZ = "Asia/Kolkata";
const ist = (iso: string) => new Date(`${iso}+05:30`);
const WH: WorkingHours = { timezone: TZ, days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" };

describe("nudge quiet hours (21:00–10:00 → 10:30)", () => {
  const shift = (iso: string) => shiftOutOfQuietHours(ist(iso), TZ, "21:00", "10:00", "10:30").toISOString();
  it("a nudge due at 22:00 moves to 10:30 the next day", () => {
    expect(shift("2026-10-19T22:00:00")).toBe(ist("2026-10-20T10:30:00").toISOString());
  });
  it("after midnight it moves to 10:30 the same morning", () => {
    expect(shift("2026-10-20T02:15:00")).toBe(ist("2026-10-20T10:30:00").toISOString());
  });
  it("inside allowed hours it stays put", () => {
    expect(shift("2026-10-19T20:59:00")).toBe(ist("2026-10-19T20:59:00").toISOString());
    expect(shift("2026-10-19T10:00:00")).toBe(ist("2026-10-19T10:00:00").toISOString());
  });
});

describe("nudge cap + bot pause", () => {
  it("max 2 nudges per lead", () => {
    expect(canSendNudge(0, 2)).toBe(true);
    expect(canSendNudge(1, 2)).toBe(true);
    expect(canSendNudge(2, 2)).toBe(false);
  });
  it("button taps are answered during the bot pause; unprompted messages are not", () => {
    expect(pauseBlocks("tap", true, true)).toBe(false);
    expect(pauseBlocks("tap", true, false)).toBe(true); // old v2 behaviour
    expect(pauseBlocks("text", true, true)).toBe(true);
    expect(pauseBlocks("scheduled", true, true)).toBe(true);
    expect(pauseBlocks("scheduled", false, true)).toBe(false);
  });
});

describe("30-minute slots with capacity", () => {
  const cfg: ListSlotConfig = {
    times: ["11:00", "12:30", "15:00", "17:30"],
    slot_minutes: 30,
    days: 2,
    max_rows: 6,
    min_lead_minutes: 60,
    words: { en: { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] }, hi: { days: ["सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि", "रवि"] } },
  };
  it("offers up to 6 free slots over the next 2 working days, labels ≤ 24 chars", () => {
    const slots = computeListSlots(ist("2026-10-19T12:00:00"), WH, cfg, "en", {}, 2); // Monday noon
    expect(slots.map((s) => s.label)).toEqual([
      "Mon 3:00–3:30 PM",
      "Mon 5:30–6:00 PM",
      "Tue 11:00–11:30 AM",
      "Tue 12:30–1:00 PM",
      "Tue 3:00–3:30 PM",
      "Tue 5:30–6:00 PM",
    ]);
    expect(slots.every((s) => s.label.length <= 24)).toBe(true);
    expect(slots[0].long).toBe("Mon 19 Oct, 3:00–3:30 PM");
    expect(slots[0].start).toBe(ist("2026-10-19T15:00:00").toISOString());
  });
  it("a slot with 2 bookings is not shown (no 3rd booking)", () => {
    const full = ist("2026-10-19T15:00:00").toISOString();
    const slots = computeListSlots(ist("2026-10-19T12:00:00"), WH, cfg, "en", { [full]: 2 }, 2);
    expect(slots.map((s) => s.start)).not.toContain(full);
    const oneLeft = computeListSlots(ist("2026-10-19T12:00:00"), WH, cfg, "en", { [full]: 1 }, 2);
    expect(oneLeft.map((s) => s.start)).toContain(full);
  });
  it("skips Sunday and slots starting within the next hour", () => {
    const slots = computeListSlots(ist("2026-10-17T17:00:00"), WH, cfg, "hi", {}, 2); // Saturday 5 PM
    expect(slots[0].label).toBe("सोम 11:00–11:30 AM");
    expect(slots.some((s) => s.label.startsWith("रवि"))).toBe(false);
  });
  it("formats ranges across noon", () => {
    expect(slotRange(11 * 60 + 30, 12 * 60)).toBe("11:30 AM–12:00 PM");
    expect(slotRange(11 * 60, 11 * 60 + 30)).toBe("11:00–11:30 AM");
  });
});

describe("demo-day reminder time", () => {
  const due = (slot: string, now: string) =>
    demoReminderDue(ist(slot), ist(now), TZ, "10:00", "12:00", 2)?.toISOString() ?? null;
  it("10:00 on the demo day", () => {
    expect(due("2026-10-20T15:00:00", "2026-10-19T12:00:00")).toBe(ist("2026-10-20T10:00:00").toISOString());
  });
  it("2 hours before a slot that starts before noon", () => {
    expect(due("2026-10-20T11:00:00", "2026-10-19T12:00:00")).toBe(ist("2026-10-20T09:00:00").toISOString());
  });
  it("none when that moment has passed (booked the same day)", () => {
    expect(due("2026-10-19T15:00:00", "2026-10-19T12:00:00")).toBeNull();
  });
});

describe("agent name in messages", () => {
  const POOL = ["deepa", "purushottam"];
  it("uses the assignee's first name when they're in the pool", () => {
    expect(agentNameFor("deepa", "Deepa Tyagi", POOL, true)).toBe("Deepa");
  });
  it("a chat with someone outside the pool reads 'our team' (null)", () => {
    expect(agentNameFor("rahul", "Rahul Patel", POOL, true)).toBeNull();
    expect(agentNameFor(null, null, POOL, true)).toBeNull();
  });
  it("a manual reassignment within the pool uses the new agent", () => {
    expect(agentNameFor("purushottam", "Purushottam Kumar", POOL, true)).toBe("Purushottam");
  });
});

describe("tag removal rules", () => {
  it("'Lost:*' matches every Lost: tag, case-insensitively", () => {
    expect(tagMatches("Lost:*", "Lost: Price")).toBe(true);
    expect(tagMatches("Lost:*", "lost: not-dsa")).toBe(true);
    expect(tagMatches("Lost:*", "Contacted")).toBe(false);
    expect(tagMatches("Lost: Not-DSA", "Lost: Not-DSA")).toBe(true);
    expect(tagMatches("Lost: Not-DSA", "Lost: Price")).toBe(false);
  });
});

describe("which flow handles a contact (test first, then newest live)", () => {
  const mk = (id: string, routing: "off" | "test" | "live", created: string, test: string[] = []): V2Bundle => ({
    flow: { id, status: "active", created_at: created },
    settings: { routing, test_phones: test } as unknown as V2Settings,
  });
  const v2 = mk("v2", "live", "2026-10-16T00:00:00Z");
  it("test numbers get v3 while v2 stays live for everyone else", () => {
    const v3 = mk("v3", "test", "2026-10-18T00:00:00Z", ["919000000101"]);
    expect(pickBundle([v2, v3], "919000000101")?.flow.id).toBe("v3");
    expect(pickBundle([v2, v3], "919876543210")?.flow.id).toBe("v2");
  });
  it("switching v3 to live takes over; back to test rolls back", () => {
    expect(pickBundle([v2, mk("v3", "live", "2026-10-18T00:00:00Z")], "919876543210")?.flow.id).toBe("v3");
    expect(pickBundle([v2, mk("v3", "test", "2026-10-18T00:00:00Z")], "919876543210")?.flow.id).toBe("v2");
  });
});
