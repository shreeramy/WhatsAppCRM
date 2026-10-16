import { describe, expect, it } from "vitest";
import {
  callFollowUpDue,
  computeDemoSlots,
  decideEntry,
  decodeSlotReplyId,
  detectLanguage,
  encodeSlotReplyId,
  fill,
  isBotPaused,
  isWithinWorkingHours,
  matchTextIntent,
  nudgeDue,
  parseFormSubmission,
  resolveTap,
  type EntryFacts,
  type SlotConfig,
} from "./logic";
import { phoneInList, v2AppliesTo, type V2Settings, type WorkingHours } from "./settings";

const WH: WorkingHours = { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" };
// IST = UTC+5:30. 2026-10-16 is a Friday.
const ist = (iso: string) => new Date(`${iso}+05:30`);

const ENTRY: V2Settings["entry"] = {
  reengage_after_days: 30,
  skip_if_agent_active_hours: 72,
  skip_if_run_finished_days: 30,
  opening_grace_seconds: 120,
};

const SLOTS: SlotConfig = {
  cutoff: "17:00",
  slots: [
    { day: "today", start: "17:00", end: "19:00", range: { en: "5–7 PM", hi: "शाम 5–7" } },
    { day: "next", start: "11:00", end: "13:00", range: { en: "11 AM–1 PM", hi: "सुबह 11–1" } },
    { day: "next", start: "17:00", end: "19:00", range: { en: "5–7 PM", hi: "शाम 5–7" } },
  ],
  words: {
    en: { today: "Today", tomorrow: "Tomorrow", days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
    hi: { today: "आज", tomorrow: "कल", days: ["सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि", "रवि"] },
  },
};

const NODES = [
  {
    node_key: "e1",
    node_type: "send_buttons",
    config: {
      buttons: [
        { reply_id: "v2.e1.dsa", title: "I run a DSA business", next_node_key: "e3" },
        { reply_id: "v2.e1.code", title: "Want DSA code", next_node_key: "e2" },
      ],
    },
  },
  {
    node_key: "e4a",
    node_type: "send_buttons",
    config: {
      buttons: [
        { reply_id: "v2.e4a.demo", title: "Book free demo", next_node_key: "e5" },
        { reply_id: "v2.e4a.video", title: "Watch video first", next_node_key: "e7" },
      ],
      title_aliases: { "Free demo book करें": "h5" },
    },
  },
  { node_key: "e5", node_type: "send_buttons", config: { dynamic_slots: { ...SLOTS, next_node_key: "e5_done" } } },
];

describe("global buttons (resolveTap)", () => {
  it("jumps to a button's branch from any earlier message, not just the current step", () => {
    // Run is on the video step; the lead taps "Book free demo" on the older plan message.
    expect(resolveTap(NODES, "v2.e4a.demo", "Book free demo")).toEqual({ kind: "node", node_key: "e5", via: "reply_id" });
    // …and the very first welcome button still works too.
    expect(resolveTap(NODES, "v2.e1.code", "Want DSA code")).toEqual({ kind: "node", node_key: "e2", via: "reply_id" });
  });

  it("maps taps on the OLD flow's buttons by title (old ids like 'yes' are reused across steps)", () => {
    expect(resolveTap(NODES, "yes", "Book free demo")).toEqual({ kind: "node", node_key: "e5", via: "title" });
    expect(resolveTap(NODES, "btn_3", " watch video  first ")).toEqual({ kind: "node", node_key: "e7", via: "title" });
    expect(resolveTap(NODES, "yes", "Free demo book करें")).toEqual({ kind: "node", node_key: "h5", via: "title" });
    expect(resolveTap(NODES, "yes", "Something else")).toBeNull();
  });

  it("round-trips a demo slot through the reply id", () => {
    const [slot] = computeDemoSlots(ist("2026-10-16T12:00:00"), WH, SLOTS, "en");
    const id = encodeSlotReplyId("e5", slot);
    expect(decodeSlotReplyId(id)).toEqual({ nodeKey: "e5", start: slot.start, end: slot.end, long: slot.long });
    expect(resolveTap(NODES, id, slot.label)).toEqual({
      kind: "slot",
      node_key: "e5_done",
      start: slot.start,
      end: slot.end,
      long: slot.long,
    });
  });
});

describe("Hindi trigger (detectLanguage)", () => {
  const settings = { language: { hindi_prefill: ["नमस्ते! क्या मुझे इस बारे में और पता चल सकता है?"], contact_field: "flow_language" } };
  it("goes Hindi for Devanagari, the Hindi ad text, or a Hindi form", () => {
    expect(detectLanguage("नमस्ते! क्या मुझे इस बारे में और पता चल सकता है?", settings)).toBe("hi");
    expect(detectLanguage("mujhe CRM chahiye — कितना है?", settings)).toBe("hi");
    expect(detectLanguage("Hello", settings, "Hindi")).toBe("hi");
  });
  it("defaults to English (no keyword needed)", () => {
    expect(detectLanguage("Hello! Can I get more info on this?", settings)).toBe("en");
    expect(detectLanguage("", settings)).toBe("en");
    expect(detectLanguage("Lead kha se launga", settings)).toBe("en");
  });
});

describe("form trigger", () => {
  const form = { field_map: { screen_0__0: "name" as const }, language_field: null };
  it("maps screen_0__0 to the contact name and finds an email", () => {
    const p = parseFormSubmission('{"screen_0__0":"rajanikanta rout","screen_0__1":"r@x.in","flow_token":"abc"}', form);
    expect(p.name).toBe("rajanikanta rout");
    expect(p.email).toBe("r@x.in");
    expect(p.fields).not.toHaveProperty("flow_token");
  });
  it("survives bad JSON", () => {
    expect(parseFormSubmission("oops", form)).toEqual({ name: null, email: null, language: null, fields: {} });
  });
  it("a form always starts v2 for a contact without a run, even a known one", () => {
    const now = ist("2026-10-16T12:00:00");
    const facts: EntryFacts = {
      kind: "form",
      isFirstInbound: false,
      lastPriorMessageAt: new Date(now.getTime() - 3600_000),
      lastAgentMessageAt: null,
      lastFinishedRunAt: null,
      hasActiveRun: false,
      now,
    };
    expect(decideEntry(facts, ENTRY)).toEqual({ action: "start", reason: "form" });
    // …but never a second time while a run is active (form + text).
    expect(decideEntry({ ...facts, hasActiveRun: true }, ENTRY)).toEqual({ action: "continue" });
  });
});

describe("entry rules + bot pause", () => {
  const now = ist("2026-10-16T12:00:00");
  const base: EntryFacts = {
    kind: "text",
    isFirstInbound: true,
    lastPriorMessageAt: null,
    lastAgentMessageAt: null,
    lastFinishedRunAt: null,
    hasActiveRun: false,
    now,
  };
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

  it("starts for a brand-new contact on ANY first message", () => {
    expect(decideEntry(base, ENTRY)).toEqual({ action: "start", reason: "first_message" });
  });
  it("re-engages a contact silent for 30+ days, not a recent one", () => {
    expect(decideEntry({ ...base, isFirstInbound: false, lastPriorMessageAt: hoursAgo(31 * 24) }, ENTRY)).toEqual({
      action: "start",
      reason: "reengaged",
    });
    expect(decideEntry({ ...base, isFirstInbound: false, lastPriorMessageAt: hoursAgo(5 * 24) }, ENTRY)).toEqual({
      action: "fallback",
      reason: "recent_contact",
    });
  });
  it("stays out while an agent messaged in the last 72h (no restart mid-demo)", () => {
    expect(decideEntry({ ...base, isFirstInbound: false, lastAgentMessageAt: hoursAgo(10) }, ENTRY)).toEqual({
      action: "agent_active",
    });
    expect(isBotPaused(hoursAgo(71), now, 72)).toBe(true);
    expect(isBotPaused(hoursAgo(73), now, 72)).toBe(false);
    expect(isBotPaused(null, now, 72)).toBe(false);
  });
  it("does not restart within 30 days of a finished run", () => {
    expect(decideEntry({ ...base, lastFinishedRunAt: hoursAgo(48) }, ENTRY)).toEqual({
      action: "fallback",
      reason: "recently_finished",
    });
  });
});

describe("working hours + slots (IST)", () => {
  it("knows working hours", () => {
    expect(isWithinWorkingHours(ist("2026-10-16T10:00:00"), WH)).toBe(true);
    expect(isWithinWorkingHours(ist("2026-10-16T19:00:00"), WH)).toBe(false);
    expect(isWithinWorkingHours(ist("2026-10-18T12:00:00"), WH)).toBe(false); // Sunday
  });

  it("offers today/tomorrow before 5 PM", () => {
    const slots = computeDemoSlots(ist("2026-10-16T12:00:00"), WH, SLOTS, "en");
    expect(slots.map((s) => s.label)).toEqual(["Today 5–7 PM", "Tomorrow 11 AM–1 PM", "Tomorrow 5–7 PM"]);
    expect(slots[0].start).toBe(ist("2026-10-16T17:00:00").toISOString());
    expect(slots[1].start).toBe(ist("2026-10-17T11:00:00").toISOString());
    expect(slots[0].long).toBe("Fri 16 Oct, 5–7 PM");
    expect(slots.every((s) => s.label.length <= 20)).toBe(true);
  });

  it("after 5 PM on Saturday shifts to Monday/Tuesday with day names", () => {
    const slots = computeDemoSlots(ist("2026-10-17T18:00:00"), WH, SLOTS, "en");
    expect(slots.map((s) => s.label)).toEqual(["Mon 5–7 PM", "Tue 11 AM–1 PM", "Tue 5–7 PM"]);
    expect(slots[0].start).toBe(ist("2026-10-19T17:00:00").toISOString());
  });

  it("after 5 PM on a weekday: next working day becomes 'Tomorrow'", () => {
    const slots = computeDemoSlots(ist("2026-10-15T17:30:00"), WH, SLOTS, "hi");
    expect(slots.map((s) => s.label)).toEqual(["कल शाम 5–7", "शनि सुबह 11–1", "शनि शाम 5–7"]);
  });

  it("call follow-up: +30 min in hours, else next working day 10:00", () => {
    const at = ist("2026-10-16T12:00:00");
    expect(callFollowUpDue(at, WH, true).toISOString()).toBe(ist("2026-10-16T12:30:00").toISOString());
    expect(callFollowUpDue(ist("2026-10-17T20:00:00"), WH, false).toISOString()).toBe(ist("2026-10-19T10:00:00").toISOString());
    expect(callFollowUpDue(ist("2026-10-16T08:00:00"), WH, false).toISOString()).toBe(ist("2026-10-16T10:00:00").toISOString());
  });

  it("nudge: +2h inside hours, else next working day 10:30", () => {
    expect(nudgeDue(ist("2026-10-16T12:00:00"), WH, 120).toISOString()).toBe(ist("2026-10-16T14:00:00").toISOString());
    expect(nudgeDue(ist("2026-10-16T18:00:00"), WH, 120).toISOString()).toBe(ist("2026-10-17T10:30:00").toISOString());
    expect(nudgeDue(ist("2026-10-17T18:00:00"), WH, 120).toISOString()).toBe(ist("2026-10-19T10:30:00").toISOString());
  });
});

describe("free text that answers the question", () => {
  const intents = [
    { keywords: ["team", "5 log", "मेरी team"], at_nodes: ["e3", "h3"], target: { en: "e4b", hi: "h4b" } },
    { keywords: ["akela", "single", "just me", "सिर्फ मैं"], at_nodes: ["e3", "h3"], target: { en: "e4a", hi: "h4a" } },
    {
      keywords: ["price", "kitna", "charges"],
      target: { en: "e3", hi: "h3" },
      by_var: { var: "plan", map: { individual: { en: "e4a", hi: "h4a" }, team: { en: "e4b", hi: "h4b" } } },
    },
  ];
  it("maps team-size answers only while that question is open", () => {
    expect(matchTextIntent("hamare paas 5 log hai", intents, "e3", "en", {})).toBe("e4b");
    expect(matchTextIntent("main akela kaam karta hu", intents, "e3", "en", {})).toBe("e4a");
    expect(matchTextIntent("akela", intents, "e1", "en", {})).toBeNull();
    expect(matchTextIntent("steam", intents, "e3", "en", {})).toBeNull();
  });
  it("price questions go to the plan already shown, else the team-size question", () => {
    expect(matchTextIntent("Price kitna hai?", intents, "e7", "en", { plan: "team" })).toBe("e4b");
    expect(matchTextIntent("charges?", intents, null, "hi", {})).toBe("h3");
    expect(matchTextIntent("Lead kahan se laun?", intents, "e7", "en", {})).toBeNull();
  });
});

describe("routing + interpolation", () => {
  const s = { routing: "test", test_phones: ["+91 98765 43210"] } as unknown as V2Settings;
  it("test mode only covers allow-listed numbers, in any format", () => {
    expect(v2AppliesTo(s, "919876543210")).toBe(true);
    expect(v2AppliesTo(s, "09876543210")).toBe(true);
    expect(v2AppliesTo(s, "919000000000")).toBe(false);
    expect(v2AppliesTo({ ...s, routing: "live" }, "919000000000")).toBe(true);
    expect(v2AppliesTo({ ...s, routing: "off" }, "919876543210")).toBe(false);
    expect(phoneInList(null, ["1"])).toBe(false);
  });
  it("fills {{placeholders}}", () => {
    expect(fill("{{agent_first_name}} will call — {{slot}}", { agent_first_name: "Deepa", slot: "Fri 16 Oct, 5–7 PM" })).toBe(
      "Deepa will call — Fri 16 Oct, 5–7 PM",
    );
  });
});
