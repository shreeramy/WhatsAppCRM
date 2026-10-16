/**
 * Call Next outcomes against a real database. Skipped unless
 * FLOW_INT_DB=1 (same switch as the flow-v2 DB tests). Creates a
 * "[TEST]" contact, chat and deal and deletes them afterwards.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadCallNext, logOutcome } from "./server";

const enabled = process.env.FLOW_INT_DB === "1";

describe.skipIf(!enabled)("Call Next — outcomes", { timeout: 60_000 }, () => {
  let db: SupabaseClient;
  let accountId: string;
  let ownerId: string;
  let agentId: string;
  let contactId: string;
  let convId: string;
  let dealId: string;

  beforeAll(async () => {
    const env = Object.fromEntries(
      readFileSync(".env.local", "utf8")
        .split(/\r?\n/)
        .filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
    db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: owner } = await db.from("profiles").select("user_id, account_id").eq("account_role", "owner").limit(1).single();
    accountId = owner!.account_id;
    ownerId = owner!.user_id;
    agentId = ownerId; // log calls as the owner so no agent gets notifications
    const { data: c } = await db.from("contacts").insert({ account_id: accountId, user_id: ownerId, phone: "919000000777", name: "[TEST] call next" }).select("id").single();
    contactId = c!.id;
    const { data: conv } = await db
      .from("conversations")
      .insert({ account_id: accountId, user_id: ownerId, contact_id: contactId, status: "open", assigned_agent_id: agentId })
      .select("id")
      .single();
    convId = conv!.id;
    const { data: pipe } = await db.from("pipelines").select("id").eq("account_id", accountId).eq("name", "Sales Pipeline").single();
    const { data: stage } = await db.from("pipeline_stages").select("id").eq("pipeline_id", pipe!.id).eq("name", "New Lead").single();
    const { data: deal } = await db
      .from("deals")
      .insert({ account_id: accountId, user_id: ownerId, pipeline_id: pipe!.id, stage_id: stage!.id, contact_id: contactId, conversation_id: convId, title: "[TEST] call next", value: 600, status: "open" })
      .select("id")
      .single();
    dealId = deal!.id;
    // An overdue follow-up puts the lead at the top of the queue.
    await db.from("follow_ups").insert({ account_id: accountId, contact_id: contactId, conversation_id: convId, type: "call", title: "[TEST] call back", due_at: new Date(Date.now() - 3600_000).toISOString(), assigned_to: agentId });
  });

  afterAll(async () => {
    if (!db) return;
    if (dealId) await db.from("deals").delete().eq("id", dealId);
    if (contactId) await db.from("contacts").delete().eq("id", contactId);
  });

  it("queue → demo booked → follow-up, tag, stage; lead leaves the queue", async () => {
    const before = await loadCallNext(db, accountId, agentId);
    expect(before.items.find((i) => i.contactId === contactId)?.reason).toBe("followUpOverdue");

    const demoAt = new Date(Date.now() + 26 * 3600_000);
    const done = await logOutcome(db, { accountId, agentId, contactId, conversationId: convId, outcome: "demo_booked", at: demoAt.toISOString() });
    expect(done).toEqual(expect.arrayContaining(["closed 1 follow-up(s)", "deal → Demo Booked", "demo follow-up added"]));

    const { data: deal } = await db.from("deals").select("stage:pipeline_stages(name)").eq("id", dealId).single();
    expect((deal as unknown as { stage: { name: string } }).stage.name).toBe("Demo Booked");
    const { data: fus } = await db.from("follow_ups").select("type, due_at, completed_at").eq("contact_id", contactId).order("created_at");
    expect(fus!.map((f) => [f.type, !!f.completed_at])).toEqual([["call", true], ["meeting", false]]);
    expect(Date.parse(fus![1].due_at)).toBe(demoAt.getTime() - 15 * 60000);

    const after = await loadCallNext(db, accountId, agentId);
    expect(after.items.find((i) => i.contactId === contactId)).toBeUndefined();
    expect(after.doneToday).toBeGreaterThanOrEqual(1);
  });

  it("three unanswered calls tag Not reachable; not interested closes the deal", async () => {
    for (let i = 0; i < 3; i++) await logOutcome(db, { accountId, agentId, contactId, conversationId: convId, outcome: "no_answer" });
    const { data: tags } = await db.from("contact_tags").select("tags(name)").eq("contact_id", contactId);
    // An existing tag with the same name in any case is reused.
    expect((tags as unknown as Array<{ tags: { name: string } }>).map((t) => t.tags.name.toLowerCase())).toContain("not reachable");

    await logOutcome(db, { accountId, agentId, contactId, conversationId: convId, outcome: "not_interested", reason: "price" });
    const { data: deal } = await db.from("deals").select("status, notes").eq("id", dealId).single();
    expect(deal!.status).toBe("lost");
    expect(deal!.notes).toContain("Lost after call: price");
  });
});
