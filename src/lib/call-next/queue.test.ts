import { describe, expect, it } from "vitest";
import { buildQueue, type QConversation, type QueueInput } from "./queue";

const now = new Date("2026-10-16T10:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
const inMin = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();

const conv = (id: string, extra: Partial<QConversation> = {}): QConversation => ({
  id: `conv-${id}`,
  contact_id: id,
  name: `Lead ${id}`,
  phone: `9198000000${id}`,
  status: "open",
  last_message_text: "hi",
  last_message_at: ago(300),
  last_message_sender: "bot",
  unread_count: 0,
  ...extra,
});

const base = (over: Partial<QueueInput> = {}): QueueInput => ({
  conversations: [],
  tags: [],
  followUps: [],
  deals: [],
  outcomes: [],
  now,
  endOfToday: new Date("2026-10-16T18:29:59Z"),
  ...over,
});

describe("Call Next queue", () => {
  it("orders by urgency: call request, demo soon, waiting customer, overdue follow-up, then today's work", () => {
    const q = buildQueue(
      base({
        conversations: ["1", "2", "3", "4", "5", "6", "7", "8"].map((id) =>
          conv(id, id === "4" ? { last_message_sender: "customer", unread_count: 2, last_message_at: ago(20) } : {}),
        ),
        tags: [
          { contact_id: "2", name: "Call Requested", added_at: ago(12) },
          { contact_id: "5", name: "No reply", added_at: ago(30) },
          { contact_id: "6", name: "Price Sent", added_at: ago(90) },
          { contact_id: "8", name: "Nurture", added_at: ago(26 * 60) },
        ],
        followUps: [
          { id: "f1", contact_id: "1", conversation_id: "conv-1", type: "call", title: "Call back", due_at: ago(120) },
          { id: "f3", contact_id: "3", conversation_id: "conv-3", type: "meeting", title: "Demo", due_at: inMin(30) },
          { id: "f7", contact_id: "7", conversation_id: "conv-7", type: "call", title: "Evening call", due_at: inMin(180) },
        ],
      }),
    );
    expect(q.map((i) => [i.contactId, i.reason, i.tier])).toEqual([
      ["2", "callRequested", "now"],
      ["3", "demoSoon", "now"],
      ["4", "customerWaiting", "now"],
      ["1", "followUpOverdue", "now"],
      ["5", "noReply", "today"],
      ["6", "priceSent", "today"],
      ["7", "followUpToday", "today"],
      ["8", "nurture", "today"],
    ]);
  });

  it("shows each lead once, under its most urgent reason", () => {
    const q = buildQueue(
      base({
        conversations: [conv("1")],
        tags: [
          { contact_id: "1", name: "Price Sent", added_at: ago(60) },
          { contact_id: "1", name: "call requested", added_at: ago(5) },
        ],
      }),
    );
    expect(q).toHaveLength(1);
    expect(q[0].reason).toBe("callRequested");
  });

  it("a logged call clears the reason; no answer comes back after 2h, three tries drop it", () => {
    const input = base({
      conversations: [conv("1")],
      tags: [{ contact_id: "1", name: "Call Requested", added_at: ago(200) }],
    });
    expect(buildQueue({ ...input, outcomes: [{ contact_id: "1", outcome: "no_answer", created_at: ago(30) }] })).toEqual([]);
    // 2h later: try again.
    const retry = buildQueue({ ...input, outcomes: [{ contact_id: "1", outcome: "no_answer", created_at: ago(150) }] });
    expect(retry.map((i) => [i.reason, i.tier])).toEqual([["retryCall", "today"]]);
    const withFollowUp = buildQueue({
      ...input,
      followUps: [{ id: "f", contact_id: "1", conversation_id: "conv-1", type: "call", title: "Retry", due_at: ago(10) }],
      outcomes: [
        { contact_id: "1", outcome: "no_answer", created_at: ago(400) },
        { contact_id: "1", outcome: "no_answer", created_at: ago(300) },
        { contact_id: "1", outcome: "no_answer", created_at: ago(200) },
      ],
    });
    expect(withFollowUp).toEqual([]);
  });

  it("a new customer message brings a handled lead back", () => {
    const q = buildQueue(
      base({
        conversations: [conv("1", { last_message_sender: "customer", unread_count: 1, last_message_at: ago(5) })],
        outcomes: [{ contact_id: "1", outcome: "not_interested", created_at: ago(60) }],
      }),
    );
    expect(q.map((i) => i.reason)).toEqual(["customerWaiting"]);
  });

  it("drops won/lost deals and leads pushed to later", () => {
    const input = base({
      conversations: [conv("1"), conv("2")],
      tags: [
        { contact_id: "1", name: "No reply", added_at: ago(60) },
        { contact_id: "2", name: "No reply", added_at: ago(60) },
      ],
      deals: [{ contact_id: "1", value: 600, status: "won" }],
    });
    expect(buildQueue(input).map((i) => i.contactId)).toEqual(["2"]);
    expect(buildQueue({ ...input, skipped: { "2": now.getTime() + 60_000 } })).toEqual([]);
  });

  it("overdue follow-ups: the most recently due comes first", () => {
    const q = buildQueue(
      base({
        conversations: [conv("1"), conv("2")],
        followUps: [
          { id: "a", contact_id: "1", conversation_id: "conv-1", type: "call", title: "Last week", due_at: ago(7 * 24 * 60) },
          { id: "b", contact_id: "2", conversation_id: "conv-2", type: "call", title: "An hour ago", due_at: ago(60) },
        ],
      }),
    );
    expect(q.map((i) => i.followUpTitle)).toEqual(["An hour ago", "Last week"]);
  });

  it("carries the open deal value and the follow-up title", () => {
    const [item] = buildQueue(
      base({
        conversations: [conv("1")],
        deals: [{ contact_id: "1", value: 1397, status: "open" }],
        followUps: [{ id: "f", contact_id: "1", conversation_id: "conv-1", type: "call", title: "Call back – Ravi", due_at: ago(5) }],
      }),
    );
    expect(item).toMatchObject({ dealValue: 1397, followUpTitle: "Call back – Ravi", phone: "91980000001" });
  });
});
