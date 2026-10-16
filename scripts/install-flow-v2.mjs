#!/usr/bin/env node
/**
 * Install / update a flow that runs on the v2 engine from a JSON file
 * (default: supabase/flows/dsa-welcome-v2.json).
 *
 *   node scripts/install-flow-v2.mjs \
 *     --pool <userId>,<userId> \
 *     --replaces <old flow id> \
 *     [--test-phones 9198…,9197…] [--dry-run-phones …] [--file path]
 *
 * - Creates the flow (status active, trigger "manual" so the original
 *   engine never starts it) or replaces its nodes if one with the same
 *   name exists. Settings are merged: routing and test numbers already
 *   set in the app are kept unless passed here.
 * - Never touches any other flow.
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]?.startsWith("--") ? "" : all[i + 1] ?? ""]);
    return acc;
  }, []),
);
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const def = JSON.parse(readFileSync(args.file || "supabase/flows/dsa-welcome-v2.json", "utf8"));

const { data: owner, error: ownerErr } = await db
  .from("profiles")
  .select("user_id, account_id")
  .eq("account_role", "owner")
  .limit(1)
  .single();
if (ownerErr) throw ownerErr;

const pool = list(args.pool);
if (pool) {
  const { data: members } = await db.from("profiles").select("user_id").eq("account_id", owner.account_id).in("user_id", pool);
  if ((members ?? []).length !== pool.length) throw new Error("--pool has ids that are not members of this account");
}

const { data: existing } = await db
  .from("flows")
  .select("id")
  .eq("account_id", owner.account_id)
  .eq("name", def.name)
  .maybeSingle();

let flowId = existing?.id;
if (!flowId) {
  const { data: flow, error } = await db
    .from("flows")
    .insert({
      account_id: owner.account_id,
      user_id: owner.user_id,
      name: def.name,
      description: def.description,
      status: "active",
      trigger_type: "manual",
      trigger_config: {},
      entry_node_id: "start",
    })
    .select("id")
    .single();
  if (error) throw error;
  flowId = flow.id;
  console.log("created flow", flowId);
} else {
  await db.from("flows").update({ description: def.description, entry_node_id: "start" }).eq("id", flowId);
  const { error } = await db.from("flow_nodes").delete().eq("flow_id", flowId);
  if (error) throw error;
  console.log("updating flow", flowId);
}

// Lay nodes out in two columns (English / Hindi) so the builder canvas is readable.
let en = 0;
let hi = 0;
const rows = def.nodes.map((n) => {
  const isHi = n.config.lang === "hi";
  const y = (isHi ? hi++ : en++) * 180;
  return {
    flow_id: flowId,
    node_key: n.node_key,
    node_type: n.node_type,
    config: n.config,
    position_x: isHi ? 520 : 0,
    position_y: y,
  };
});
const { error: nodesErr } = await db.from("flow_nodes").insert(rows);
if (nodesErr) throw nodesErr;

const { data: current } = await db.from("flow_engine_settings").select("settings").eq("flow_id", flowId).maybeSingle();
const prev = current?.settings ?? {};
const settings = {
  ...def.settings,
  routing: prev.routing ?? def.settings.routing,
  test_phones: list(args["test-phones"]) ?? prev.test_phones ?? def.settings.test_phones,
  dry_run_phones: list(args["dry-run-phones"]) ?? prev.dry_run_phones ?? def.settings.dry_run_phones,
  agent_pool: pool ?? prev.agent_pool ?? def.settings.agent_pool,
  replaces_flow_id: args.replaces || prev.replaces_flow_id || def.settings.replaces_flow_id,
  test_overrides: { ...def.settings.test_overrides, ...(prev.test_overrides ?? {}) },
};
if (!settings.agent_pool?.length) throw new Error("No agent pool — pass --pool <userId>,<userId>");
const { error: setErr } = await db
  .from("flow_engine_settings")
  .upsert({ flow_id: flowId, account_id: owner.account_id, settings, updated_at: new Date().toISOString() });
if (setErr) throw setErr;

console.log(
  JSON.stringify(
    { flowId, nodes: rows.length, routing: settings.routing, test_phones: settings.test_phones, pool: settings.agent_pool },
    null,
    2,
  ),
);
