/**
 * Database-level concurrency tests for the v2 engine: step dedupe, tap
 * ordering and round-robin under concurrent load. They run against a
 * real Supabase project and are skipped unless FLOW_INT_DB=1:
 *
 *   FLOW_INT_DB=1 FLOW_INT_POOL=<agentId>,<agentId> npx vitest run src/lib/flows/v2/db.int.test.ts
 *
 * Every row they create is named "[TEST] …" and deleted afterwards; the
 * round-robin pointer is restored.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const enabled = process.env.FLOW_INT_DB === "1";

function env(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(".env.local", "utf8")
        .split(/\r?\n/)
        .filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
  } catch {
    return {};
  }
}

describe.skipIf(!enabled)("v2 engine — database concurrency", () => {
  let db: SupabaseClient;
  let accountId: string;
  let ownerId: string;
  const pool = (process.env.FLOW_INT_POOL ?? "").split(",").filter(Boolean);
  const contactIds: string[] = [];
  const convIds: string[] = [];
  let flowId: string;
  let savedPointer: { pool_key: string; last_agent_id: string | null } | null = null;

  beforeAll(async () => {
    const e = { ...env(), ...process.env } as Record<string, string>;
    db = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY);
    const { data: owner } = await db.from("profiles").select("user_id, account_id").eq("account_role", "owner").limit(1).single();
    accountId = owner!.account_id;
    ownerId = owner!.user_id;

    for (let i = 0; i < 6; i++) {
      const { data: c, error } = await db
        .from("contacts")
        .insert({ account_id: accountId, user_id: ownerId, phone: `91900000${String(900 + i)}`, name: `[TEST] rr ${i}` })
        .select("id")
        .single();
      if (error) throw error;
      contactIds.push(c.id);
      const { data: conv, error: cErr } = await db
        .from("conversations")
        .insert({ account_id: accountId, user_id: ownerId, contact_id: c.id, status: "open" })
        .select("id")
        .single();
      if (cErr) throw cErr;
      convIds.push(conv.id);
    }
    const { data: f, error: fErr } = await db
      .from("flows")
      .insert({ account_id: accountId, user_id: ownerId, name: "[TEST] claim flow", status: "draft", trigger_type: "manual" })
      .select("id")
      .single();
    if (fErr) throw fErr;
    flowId = f.id;

    const poolKey = [...pool].sort().join(",");
    const { data: ptr } = await db
      .from("round_robin_pointers")
      .select("pool_key, last_agent_id")
      .eq("account_id", accountId)
      .eq("pool_key", poolKey)
      .maybeSingle();
    savedPointer = ptr ?? { pool_key: poolKey, last_agent_id: null };
  });

  afterAll(async () => {
    if (!db) return;
    if (flowId) await db.from("flows").delete().eq("id", flowId);
    if (contactIds.length) await db.from("contacts").delete().in("id", contactIds);
    if (savedPointer) {
      await db
        .from("round_robin_pointers")
        .update({ last_agent_id: savedPointer.last_agent_id })
        .eq("account_id", accountId)
        .eq("pool_key", savedPointer.pool_key);
    }
  });

  it("dedupe: of 10 concurrent sends of the same step, exactly one is allowed", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.rpc("flow_claim_step", { p_contact_id: contactIds[0], p_flow_id: flowId, p_node_key: "e3", p_window_seconds: 2 }),
      ),
    );
    expect(results.map((r) => r.error)).toEqual(Array(10).fill(null));
    expect(results.filter((r) => r.data === true)).toHaveLength(1);
    // A different step is independent…
    const other = await db.rpc("flow_claim_step", { p_contact_id: contactIds[0], p_flow_id: flowId, p_node_key: "e4a", p_window_seconds: 2 });
    expect(other.data).toBe(true);
    // …and the same step is allowed again after the window.
    await new Promise((r) => setTimeout(r, 2200));
    const again = await db.rpc("flow_claim_step", { p_contact_id: contactIds[0], p_flow_id: flowId, p_node_key: "e3", p_window_seconds: 2 });
    expect(again.data).toBe(true);
  });

  it("taps: the newest tap (by Meta timestamp) wins, even if it is written first", async () => {
    const rec = (id: string, ts: number) =>
      db.rpc("flow_record_tap", { p_account_id: accountId, p_contact_id: contactIds[1], p_message_id: id, p_ts: ts });
    expect((await rec("wamid.A", 1000)).data).toBe("wamid.A");
    expect((await rec("wamid.C", 1002)).data).toBe("wamid.C");
    // A late-delivered older tap must not take over.
    expect((await rec("wamid.B", 1001)).data).toBe("wamid.C");
  });

  it.skipIf(pool.length !== 2)("round-robin: 6 concurrent chats alternate across the pool, none double-assigned", async () => {
    const results = await Promise.all(
      convIds.map((id) =>
        db.rpc("assign_round_robin", {
          p_account_id: accountId,
          p_agent_ids: pool,
          p_conversation_id: id,
          p_force: false,
          p_skip_offline: false,
        }),
      ),
    );
    expect(results.map((r) => r.error)).toEqual(Array(6).fill(null));
    const agents = results.map((r) => r.data as string);
    const counts = pool.map((p) => agents.filter((a) => a === p).length);
    expect(counts).toEqual([3, 3]);

    const { data: convs } = await db.from("conversations").select("id, assigned_agent_id").in("id", convIds);
    for (const c of convs ?? []) expect(pool).toContain(c.assigned_agent_id);

    // Re-running keeps each chat with its agent (no reshuffle).
    const again = await Promise.all(
      convIds.map((id) =>
        db.rpc("assign_round_robin", { p_account_id: accountId, p_agent_ids: pool, p_conversation_id: id, p_force: false, p_skip_offline: false }),
      ),
    );
    expect(again.map((r) => r.data)).toEqual(agents);
  });
});
