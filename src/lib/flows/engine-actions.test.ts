import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Button click → action nodes (set_tag + handoff/round-robin).
//
// Reproduces the 2026-10-08 production bug: the flow's set_tag nodes
// stored the tag NAME ("call-requested") because the builder's tag
// picker never loaded, so every tag write failed, and handoff nodes
// had no assignment. Drives the real dispatchInboundToFlows with a
// fake DB and stubbed side effects.
// ============================================================

const TAG_ID = "cfb82ab2-58fd-4af9-8e80-b5e7917a85c5";
const AGENT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const AGENT_B = "bbbbbbbb-0000-4000-8000-000000000002";

const h = vi.hoisted(() => ({
  state: {
    activeRuns: [] as Record<string, unknown>[],
    flows: [] as unknown[],
    nodes: [] as unknown[],
    tags: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    updates: [] as { table: string; row: Record<string, unknown> }[],
  },
  addTag: vi.fn(async () => ({ added: true })),
  assignRR: vi.fn(async (): Promise<string | null> => null),
  sendText: vi.fn(async () => ({ whatsapp_message_id: "wamid.t" })),
}));

vi.mock("./admin-client", () => {
  function rows(table: string): unknown[] {
    if (table === "flow_runs") return h.state.activeRuns;
    if (table === "flows") return h.state.flows;
    if (table === "flow_nodes") return h.state.nodes;
    if (table === "tags") return h.state.tags;
    if (table === "accounts") return [{ id: "acct-1", owner_user_id: "owner-1" }];
    return [];
  }
  function builder(table: string) {
    const filters: [string, unknown, "eq" | "ilike"][] = [];
    const filtered = () =>
      (rows(table) as Record<string, unknown>[]).filter((r) =>
        table !== "tags"
          ? true
          : filters.every(([k, v, op]) =>
              op === "eq"
                ? r[k] === v
                : String(r[k]).toLowerCase() === String(v).toLowerCase(),
            ),
      );
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => {
        filters.push([k, v, "eq"]);
        return b;
      },
      ilike: (k: string, v: unknown) => {
        filters.push([k, v, "ilike"]);
        return b;
      },
      is: () => b,
      in: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: (row: Record<string, unknown>) => {
        h.state.updates.push({ table, row });
        return b;
      },
      insert: (row: Record<string, unknown>) => {
        if (table === "flow_run_events") h.state.events.push(row);
        return b;
      },
      maybeSingle: async () => ({ data: filtered()[0] ?? null, error: null }),
      single: async () => ({ data: filtered()[0] ?? null, error: null }),
      then: (resolve: (r: { data: unknown[]; error: null; count: number }) => unknown) =>
        resolve({ data: filtered(), error: null, count: 0 }),
    };
    return b;
  }
  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: h.sendText,
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.m" })),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.b" })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.l" })),
}));

vi.mock("@/lib/contacts/tag-events", () => ({ addContactTagAndDispatch: h.addTag }));
vi.mock("@/lib/assignment/round-robin", () => ({ assignRoundRobin: h.assignRR }));

import { dispatchInboundToFlows } from "./engine";
import { nextRoundRobinAgent } from "@/lib/automations/round-robin";

const FLOW = {
  id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  status: "active",
  trigger_type: "manual",
  trigger_config: {},
  entry_node_id: "pricing",
  fallback_policy: { on_unknown_reply: "reprompt", max_reprompts: 2, on_timeout_hours: 24, on_exhaust: "handoff" },
  created_at: "2026-01-01T00:00:00Z",
};

function node(node_key: string, node_type: string, config: Record<string, unknown>) {
  return { id: `n-${node_key}`, flow_id: "flow-1", node_key, node_type, config };
}

/** The production "Call me" branch: reply → tag by NAME → handoff. */
function callMeFlow(handoff: Record<string, unknown>) {
  return [
    node("pricing", "send_buttons", {
      text: "Want a demo?",
      buttons: [{ title: "Call me", reply_id: "call", next_node_key: "reply" }],
    }),
    node("reply", "send_message", { text: "Our team will call you within 4 hours", next_node_key: "tag" }),
    node("tag", "set_tag", { mode: "add", tag_id: "call-requested", next_node_key: "handoff" }),
    node("handoff", "handoff", handoff),
  ];
}

function runFor(conversationId: string) {
  return {
    id: `run-${conversationId}`,
    flow_id: "flow-1",
    account_id: "acct-1",
    user_id: "u-1",
    contact_id: `ct-${conversationId}`,
    conversation_id: conversationId,
    status: "active",
    current_node_key: "pricing",
    last_prompt_message_id: null,
    vars: {},
    reprompt_count: 0,
    started_at: "2026-10-08T11:19:49Z",
    last_advanced_at: "2026-10-08T11:19:49Z",
    ended_at: null,
    end_reason: null,
  };
}

function clickCallMe(conversationId: string) {
  h.state.activeRuns = [runFor(conversationId)];
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: `ct-${conversationId}`,
    conversationId,
    message: { kind: "interactive_reply", reply_id: "call", reply_title: "Call me", meta_message_id: `m-${conversationId}` },
    isFirstInboundMessage: false,
  });
}

beforeEach(() => {
  h.state.flows = [FLOW];
  h.state.tags = [{ id: TAG_ID, name: "call-requested", account_id: "acct-1" }];
  h.state.events = [];
  h.state.updates = [];
  h.addTag.mockClear();
  h.assignRR.mockReset();
  h.sendText.mockClear();
});

describe("button click → set_tag", () => {
  it("adds the tag even though the node stored the tag's name", async () => {
    h.state.nodes = callMeFlow({ note: "" });
    await clickCallMe("cv-1");

    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.addTag).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-1", contactId: "ct-cv-1", tagId: TAG_ID }),
    );
    expect(h.state.events).not.toContainEqual(expect.objectContaining({ event_type: "error" }));
  });

  it("logs a visible error event when the tag write fails, and still hands off", async () => {
    h.state.nodes = callMeFlow({ note: "" });
    h.addTag.mockRejectedValueOnce(new Error("boom"));
    await clickCallMe("cv-1");

    expect(h.state.events).toContainEqual(
      expect.objectContaining({
        event_type: "error",
        node_key: "tag",
        payload: expect.objectContaining({ reason: "set_tag_failed", detail: "boom" }),
      }),
    );
    expect(h.state.events).toContainEqual(expect.objectContaining({ event_type: "handoff" }));
  });
});

describe("button click → handoff with round-robin", () => {
  it("assigns via assign_round_robin with the configured pool", async () => {
    h.state.nodes = callMeFlow({ assign_mode: "round_robin", agent_ids: [AGENT_A, AGENT_B] });
    h.assignRR.mockResolvedValueOnce(AGENT_A);
    await clickCallMe("cv-1");

    expect(h.assignRR).toHaveBeenCalledWith(expect.anything(), {
      accountId: "acct-1",
      agentIds: [AGENT_A, AGENT_B],
      conversationId: "cv-1",
      force: false,
      skipOffline: false,
    });
    expect(h.state.events).toContainEqual(
      expect.objectContaining({
        event_type: "handoff",
        payload: expect.objectContaining({ assign_mode: "round_robin", assigned_to: AGENT_A }),
      }),
    );
    // Status still flips to pending for the team.
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({ table: "conversations", row: expect.objectContaining({ status: "pending" }) }),
    );
  });

  it("rotates across 3+ chats (pointer shared between runs)", async () => {
    // Same rule as the SQL function: next id after the last, wrapping.
    let last: string | undefined;
    h.assignRR.mockImplementation(async () => {
      last = nextRoundRobinAgent([AGENT_A, AGENT_B], last) ?? undefined;
      return last ?? null;
    });
    h.state.nodes = callMeFlow({ assign_mode: "round_robin", agent_ids: [AGENT_A, AGENT_B] });

    const assigned: unknown[] = [];
    for (const cv of ["cv-1", "cv-2", "cv-3", "cv-4"]) {
      h.state.events = [];
      await clickCallMe(cv);
      const ev = h.state.events.find((e) => e.event_type === "handoff") as { payload: { assigned_to: string } };
      assigned.push(ev.payload.assigned_to);
    }
    expect(assigned).toEqual([AGENT_A, AGENT_B, AGENT_A, AGENT_B]);
  });

  it("logs assign_failed when the pool is empty instead of failing silently", async () => {
    h.state.nodes = callMeFlow({ assign_mode: "round_robin" });
    h.assignRR.mockResolvedValueOnce(null);
    await clickCallMe("cv-1");

    expect(h.state.events).toContainEqual(
      expect.objectContaining({
        event_type: "error",
        payload: expect.objectContaining({ reason: "assign_failed", detail: expect.stringContaining("pool is empty") }),
      }),
    );
  });

  it("keeps legacy handoffs (no assign_mode) status-only", async () => {
    h.state.nodes = callMeFlow({ note: "" });
    await clickCallMe("cv-1");
    expect(h.assignRR).not.toHaveBeenCalled();
    expect(h.state.events).toContainEqual(
      expect.objectContaining({ event_type: "handoff", payload: expect.objectContaining({ assign_mode: "none" }) }),
    );
  });
});
