#!/usr/bin/env node
/**
 * End-to-end test of the v2 flow, by posting Meta-signed webhooks for
 * simulated test numbers to a running app and checking the database.
 *
 *   node scripts/simulate-flow-v2.mjs --base http://localhost:3123 --flow <v2 flow id> \
 *     --old-flow <old flow id> [--only 1,2] [--keep]
 *
 * Safety:
 * - Uses numbers 9190000001xx / 919000000199 only. The v2 test list and
 *   dry-run list are set to them for the run (restored afterwards), so
 *   the bot never messages Meta for them and real traffic is untouched.
 * - Contact names start with "[TEST]" so no push reaches real phones.
 * - Everything created is deleted at the end (unless --keep) and the
 *   round-robin pointer is restored.
 * Reads Supabase + META_APP_SECRET from .env.local.
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const BASE = arg("base", "http://localhost:3123");
const FLOW = arg("flow");
const OLD_FLOW = arg("old-flow");
const ONLY = arg("only") ? arg("only").split(",").map(Number) : null;
const KEEP = argv.includes("--keep");
const OUT = arg("out", "flow-v2-test-results.md");
const SIGN_LOCALLY = argv.includes("--sign-locally");

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const APP_SECRET = env.META_APP_SECRET.split(",")[0].trim();
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const PHONES = Array.from({ length: 22 }, (_, i) => `9190000001${String(i + 1).padStart(2, "0")}`);
const OLD_PHONE = "919000000199";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { data: cfg } = await db.from("whatsapp_config").select("phone_number_id, account_id").limit(1).single();
const ACCOUNT = cfg.account_id;
const { data: settingsRow } = await db.from("flow_engine_settings").select("settings").eq("flow_id", FLOW).single();
const ORIGINAL_SETTINGS = settingsRow.settings;
const POOL = ORIGINAL_SETTINGS.agent_pool;
const poolKey = [...POOL].sort().join(",");
const { data: ptr } = await db
  .from("round_robin_pointers")
  .select("last_agent_id")
  .eq("account_id", ACCOUNT)
  .eq("pool_key", poolKey)
  .maybeSingle();
const ORIGINAL_POINTER = ptr?.last_agent_id ?? null;
const { data: agents } = await db.from("profiles").select("user_id, full_name").in("user_id", POOL);
const { data: ownerRow } = await db.from("profiles").select("user_id").eq("account_id", ACCOUNT).eq("account_role", "owner").limit(1).single();
const OWNER = ownerRow.user_id;
const agentName = (id) => agents.find((a) => a.user_id === id)?.full_name ?? id;

async function setSettings(patch) {
  const { data } = await db.from("flow_engine_settings").select("settings").eq("flow_id", FLOW).single();
  await db.from("flow_engine_settings").update({ settings: { ...data.settings, ...patch } }).eq("flow_id", FLOW);
}
async function setOverrides(o) {
  const { data } = await db.from("flow_engine_settings").select("settings").eq("flow_id", FLOW).single();
  await db
    .from("flow_engine_settings")
    .update({ settings: { ...data.settings, test_overrides: { ...data.settings.test_overrides, ...o } } })
    .eq("flow_id", FLOW);
}

// ---------------------------------------------------------------- webhook
let tsCounter = Math.floor(Date.now() / 1000);
async function post(phone, message, name = `[TEST] ${phone.slice(-3)}`) {
  // Real Meta timestamps track the clock; keep them increasing too.
  tsCounter = Math.max(tsCounter + 1, Math.floor(Date.now() / 1000));
  const msg = { from: phone, id: `wamid.TEST.${randomUUID()}`, timestamp: String(tsCounter), ...message };
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "TEST",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "TEST", phone_number_id: cfg.phone_number_id },
              contacts: [{ profile: { name }, wa_id: phone }],
              messages: [msg],
            },
          },
        ],
      },
    ],
  });
  // Local app with this machine's META_APP_SECRET: post to the real
  // webhook. Deployed app: go through /api/flows/simulate, which signs
  // with the server's own secret (only for simulation numbers).
  const res = SIGN_LOCALLY
    ? await fetch(`${BASE}/api/whatsapp/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hub-signature-256": "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex"),
        },
        body,
      })
    : await fetch(`${BASE}/api/flows/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-push-secret": env.PUSH_DISPATCH_SECRET },
        body,
      });
  if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
  return msg.id;
}
const text = (phone, body, name) => post(phone, { type: "text", text: { body } }, name);
const tap = (phone, id, title) =>
  post(phone, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } });
const form = (phone, json, name) =>
  post(phone, { type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { name: "flow", response_json: json } } }, name);

// ---------------------------------------------------------------- reads
async function contactOf(phone) {
  const { data } = await db
    .from("contacts")
    .select("id, name, email")
    .eq("account_id", ACCOUNT)
    .like("phone", `%${phone.slice(-10)}`)
    .limit(1);
  return data?.[0] ?? null;
}
async function convOf(phone) {
  const c = await contactOf(phone);
  if (!c) return null;
  const { data } = await db.from("conversations").select("id, assigned_agent_id, status").eq("contact_id", c.id).maybeSingle();
  return data;
}
async function runsOf(phone, flowId = FLOW) {
  const c = await contactOf(phone);
  if (!c) return [];
  const { data } = await db
    .from("flow_runs")
    .select("id, status, current_node_key, vars, end_reason, started_at")
    .eq("flow_id", flowId)
    .eq("contact_id", c.id)
    .order("started_at");
  return data ?? [];
}
async function events(phone, flowId = FLOW) {
  const runs = await runsOf(phone, flowId);
  if (!runs.length) return [];
  const { data } = await db
    .from("flow_run_events")
    .select("flow_run_id, event_type, node_key, payload, created_at")
    .in("flow_run_id", runs.map((r) => r.id))
    .order("created_at");
  return data ?? [];
}
async function sent(phone) {
  return (await events(phone)).filter((e) => e.event_type === "message_sent").map((e) => e.node_key);
}
async function errors(phone) {
  return (await events(phone)).filter((e) => e.event_type === "error").map((e) => `${e.node_key}: ${e.payload.action ?? e.payload.reason} — ${e.payload.detail ?? ""}`);
}
async function tagsOf(phone) {
  const c = await contactOf(phone);
  const { data } = await db.from("contact_tags").select("tags(name)").eq("contact_id", c.id);
  return (data ?? []).map((r) => r.tags.name).sort();
}
async function dealOf(phone) {
  const c = await contactOf(phone);
  const { data } = await db
    .from("deals")
    .select("id, value, status, stage:pipeline_stages(name), pipeline:pipelines(name)")
    .eq("contact_id", c.id);
  return data ?? [];
}
async function followUpsOf(phone) {
  const c = await contactOf(phone);
  const { data } = await db.from("follow_ups").select("type, title, due_at, assigned_to").eq("contact_id", c.id).order("created_at");
  return data ?? [];
}
async function alertsOf(phone) {
  const conv = await convOf(phone);
  if (!conv) return [];
  const { data } = await db.from("notifications").select("type, title, user_id").eq("conversation_id", conv.id).order("created_at");
  return data ?? [];
}
async function botTexts(phone) {
  const conv = await convOf(phone);
  const { data } = await db
    .from("messages")
    .select("content_text, interactive_payload, created_at")
    .eq("conversation_id", conv.id)
    .eq("sender_type", "bot")
    .order("created_at");
  return data ?? [];
}
async function lastButtons(phone) {
  const msgs = await botTexts(phone);
  const last = [...msgs].reverse().find((m) => m.interactive_payload?.buttons);
  return last?.interactive_payload?.buttons ?? [];
}

async function waitFor(fn, label, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(800);
  }
  throw new Error(`timeout waiting for: ${label}`);
}
const waitSent = (phone, count, label) =>
  waitFor(async () => ((await sent(phone)).length >= count ? await sent(phone) : null), label ?? `${count} bot steps for ${phone}`);

// ---------------------------------------------------------------- report
const results = [];
let current = null;
function scenario(n, title, fn) {
  return { n, title, fn };
}
function check(label, ok, detail = "") {
  current.checks.push({ label, ok: !!ok, detail });
  if (!ok) current.failed = true;
}

// ---------------------------------------------------------------- scenarios
const P = (i) => PHONES[i - 1];
const EN_PREFILL = "Hello! Can I get more info on this?";
const HI_PREFILL = "नमस्ते! क्या मुझे इस बारे में और पता चल सकता है?";

const scenarios = [
  scenario(1, "English happy path → demo booked", async () => {
    const p = P(1);
    await text(p, EN_PREFILL);
    await waitSent(p, 1);
    await tap(p, "v2.e1.dsa", "I run a DSA business");
    await waitSent(p, 2);
    await tap(p, "v2.e3.solo", "Just me");
    await waitSent(p, 3);
    await tap(p, "v2.e4a.demo", "Book free demo");
    await waitSent(p, 4);
    const slots = await lastButtons(p);
    current.log.push(`slot buttons offered: ${slots.map((b) => b.title).join(" · ")}`);
    await tap(p, slots[0].id, slots[0].title);
    const s = await waitSent(p, 5);
    check("steps e1 → e3 → e4a → e5 → e5_done", s.join(",") === "e1,e3,e4a,e5,e5_done", s.join(" → "));
    const tags = await tagsOf(p);
    check("tags Contacted, Price Sent, Demo Booked", ["Contacted", "Price Sent", "Demo Booked"].every((t) => tags.includes(t)), tags.join(", "));
    const conv = await convOf(p);
    check("assigned to a pool agent", POOL.includes(conv.assigned_agent_id), agentName(conv.assigned_agent_id));
    const deals = await dealOf(p);
    check("one deal, value 600, stage Demo Booked, Sales Pipeline", deals.length === 1 && Number(deals[0].value) === 600 && deals[0].stage?.name === "Demo Booked" && deals[0].pipeline?.name === "Sales Pipeline", JSON.stringify(deals.map((d) => ({ value: d.value, stage: d.stage?.name }))));
    const fus = await followUpsOf(p);
    const slotStart = Date.parse(slots[0].id.split("|")[2]);
    check("demo follow-up for the agent at slot − 15 min", fus.length === 1 && fus[0].type === "meeting" && Date.parse(fus[0].due_at) === slotStart - 15 * 60000 && fus[0].assigned_to === conv.assigned_agent_id, fus.map((f) => `${f.title} @ ${f.due_at}`).join("; "));
    const alerts = await alertsOf(p);
    check("agent notified (in-app; push goes via the notification trigger)", alerts.some((a) => a.type === "flow_alert" && a.title.includes("Demo booked") && a.user_id === conv.assigned_agent_id), alerts.map((a) => a.title).join("; "));
    const msgs = await botTexts(p);
    current.log.push(`confirmation: "${msgs.at(-1).content_text}"`);
    check("confirmation names the slot + agent first name", msgs.at(-1).content_text.includes(agentName(conv.assigned_agent_id).split(" ")[0]));
  }),

  scenario(2, "Hindi ad text → Hindi welcome → team plan → call me (in hours + off hours)", async () => {
    for (const [p, mode] of [[P(2), "open"], [P(3), "closed"]]) {
      await setOverrides({ working_hours_mode: mode });
      await text(p, HI_PREFILL);
      const first = await waitSent(p, 1);
      check(`[${mode}] Hindi welcome sent directly (no language step)`, first[0] === "h1", first.join(","));
      await tap(p, "v2.h1.dsa", "मेरा DSA business है");
      await waitSent(p, 2);
      await tap(p, "v2.h3.team", "मेरी team है");
      await waitSent(p, 3);
      await tap(p, "v2.h4b.call", "मुझे call करें");
      const s = await waitSent(p, 4);
      check(`[${mode}] steps h1 → h3 → h4b → h6`, s.join(",") === "h1,h3,h4b,h6", s.join(" → "));
      const last = (await botTexts(p)).at(-1).content_text;
      current.log.push(`[${mode}] reply: "${last}"`);
      check(`[${mode}] ${mode === "open" ? "30-minute" : "tomorrow 10–11"} copy`, mode === "open" ? last.includes("30 मिनट") : last.includes("कल सुबह"));
      const deals = await dealOf(p);
      check(`[${mode}] deal value 1397`, deals.length === 1 && Number(deals[0].value) === 1397);
      const fu = (await followUpsOf(p))[0];
      const mins = (Date.parse(fu.due_at) - Date.now()) / 60000;
      check(`[${mode}] call follow-up ${mode === "open" ? "≈ +30 min" : "next working day 10:00 IST"}`, mode === "open" ? mins > 20 && mins < 31 : new Date(fu.due_at).toISOString().endsWith("04:30:00.000Z"), fu.due_at);
      const tags = await tagsOf(p);
      check(`[${mode}] tags Contacted, Price Sent, Call Requested`, ["Contacted", "Price Sent", "Call Requested"].every((t) => tags.includes(t)), tags.join(", "));
      const conv = await convOf(p);
      check(`[${mode}] chat marked pending (top of queue) + agent notified`, conv.status === "pending" && (await alertsOf(p)).some((a) => a.title.includes("Call requested")));
      const { data: lang } = await db.from("contact_custom_values").select("value, custom_fields(field_name)").eq("contact_id", (await contactOf(p)).id);
      check(`[${mode}] flow_language = hi on the contact`, (lang ?? []).some((v) => v.custom_fields.field_name === "flow_language" && v.value === "hi"));
    }
    await setOverrides({ working_hours_mode: "auto" });
  }),

  scenario(3, "Language switch both ways", async () => {
    const a = P(4);
    await text(a, EN_PREFILL);
    await waitSent(a, 1);
    await tap(a, "v2.e1.hindi", "हिंदी में बताएं");
    await waitSent(a, 2);
    await tap(a, "v2.h1.dsa", "मेरा DSA business है");
    const sa = await waitSent(a, 3);
    check("EN welcome → हिंदी में बताएं → rest in Hindi", sa.join(",") === "e1,h1,h3", sa.join(" → "));
    const b = P(5);
    await text(b, HI_PREFILL);
    await waitSent(b, 1);
    await tap(b, "v2.h1.english", "English please");
    await waitSent(b, 2);
    await tap(b, "v2.e1.dsa", "I run a DSA business");
    const sb = await waitSent(b, 3);
    check("HI welcome → English please → rest in English", sb.join(",") === "h1,e1,e3", sb.join(" → "));
    const runs = await runsOf(b);
    check("run language follows the switch", runs.at(-1).vars.lang === "en");
  }),

  scenario(4, "Mis-tap recovery + latest tap wins", async () => {
    const p = P(6);
    await text(p, EN_PREFILL);
    await waitSent(p, 1);
    await tap(p, "v2.e1.code", "Want DSA code");
    await waitSent(p, 2);
    check("Lost: Not-DSA tag", (await tagsOf(p)).includes("Lost: Not-DSA"));
    check("chat left unassigned on the not-a-fit step", !(await convOf(p)).assigned_agent_id);
    const { data: jobs } = await db.from("flow_scheduled_jobs").select("kind, due_at").eq("contact_id", (await contactOf(p)).id);
    check("24h auto-close scheduled", jobs.some((j) => j.kind === "auto_close"), jobs.map((j) => `${j.kind} @ ${j.due_at}`).join("; "));
    await tap(p, "v2.e2.dsa", "Oops, I am a DSA");
    await waitSent(p, 3);
    await sleep(11000); // past the 10s same-step window
    await tap(p, "v2.e1.code", "Want DSA code"); // the OLD welcome button again
    const s = await waitSent(p, 4);
    check("e1 → e2 → e3 → e2 (old button tapped again → E2 again)", s.join(",") === "e1,e2,e3,e2", s.join(" → "));
    const conv = await convOf(p);
    check("assigned once they said they're a DSA (E3)", POOL.includes(conv.assigned_agent_id), agentName(conv.assigned_agent_id));
  }),

  scenario(5, "Tap an older message's button from the video step", async () => {
    const p = P(7);
    await text(p, EN_PREFILL);
    await waitSent(p, 1);
    await tap(p, "v2.e1.dsa", "I run a DSA business");
    await waitSent(p, 2);
    await tap(p, "v2.e3.solo", "Just me");
    await waitSent(p, 3);
    await tap(p, "v2.e4a.video", "Watch video first");
    await waitSent(p, 4);
    await tap(p, "v2.e4a.demo", "Book free demo"); // on the earlier plan message
    const s = await waitSent(p, 5);
    check("e7 (video) → tap 'Book free demo' on the plan message → e5 slot picker", s.slice(-2).join(",") === "e7,e5", s.join(" → "));
    const tags = await tagsOf(p);
    // An existing "nurture" tag is reused (tag names match case-insensitively).
    check("Nurture tag", tags.some((t) => t.toLowerCase() === "nurture"), tags.join(", "));
  }),

  scenario(6, "Double taps", async () => {
    const p = P(8);
    await text(p, EN_PREFILL);
    await waitSent(p, 1);
    await Promise.all([tap(p, "v2.e1.dsa", "I run a DSA business"), sleep(700).then(() => tap(p, "v2.e1.dsa", "I run a DSA business"))]);
    await waitSent(p, 2);
    await sleep(15000); // give a duplicate time to show up
    const s = await sent(p);
    check("same button twice within 1s → one reply", s.join(",") === "e1,e3", s.join(" → "));
    const q = P(9);
    await text(q, EN_PREFILL);
    await waitSent(q, 1);
    await tap(q, "v2.e1.code", "Want DSA code");
    await sleep(1500);
    await tap(q, "v2.e1.dsa", "I run a DSA business");
    await waitSent(q, 2);
    await sleep(15000);
    const sq = await sent(q);
    check("'Want DSA code' then 'I run a DSA business' within 2s → only the last one answered", sq.join(",") === "e1,e3", sq.join(" → "));
  }),

  scenario(7, "Form submissions", async () => {
    const a = P(10);
    await form(a, JSON.stringify({ screen_0__0: "[TEST] Form Lead", flow_token: "x" }), "[TEST] wa-profile");
    await waitSent(a, 1);
    await sleep(3000);
    const sa = await sent(a);
    check("form alone → v2 starts once (E1)", sa.join(",") === "e1", sa.join(" → "));
    check("screen_0__0 stored as the contact name", (await contactOf(a)).name === "[TEST] Form Lead", (await contactOf(a)).name);
    const runs = await runsOf(a);
    check("trigger logged as form", runs[0]?.vars.trigger === "form");

    const b = P(11);
    await form(b, JSON.stringify({ screen_0__0: "[TEST] Form Lead 2" }), "[TEST] wa-profile");
    await sleep(1500);
    await text(b, EN_PREFILL);
    await sleep(8000);
    const sb = await sent(b);
    check("form + text → v2 starts once", sb.join(",") === "e1", sb.join(" → "));

    const c = P(12);
    await Promise.all([text(c, EN_PREFILL), form(c, JSON.stringify({ screen_0__0: "[TEST] Form Lead 3" }), "[TEST] wa-profile")]);
    await sleep(8000);
    const sc = await sent(c);
    const runsC = await runsOf(c);
    check("text + form at the same moment → one run, one welcome", sc.join(",") === "e1" && runsC.length === 1, `${sc.join(",")} / ${runsC.length} run(s)`);
  }),

  scenario(8, "Free text mid-flow", async () => {
    const p = P(13);
    await text(p, EN_PREFILL);
    await waitSent(p, 1);
    await tap(p, "v2.e1.dsa", "I run a DSA business");
    await waitSent(p, 2);
    await text(p, "Lead kahan se laun?");
    const s = await waitSent(p, 3);
    check("E8 reply", s.at(-1) === "e8", s.join(" → "));
    const conv = await convOf(p);
    check("assigned + agent notified + Question tag", POOL.includes(conv.assigned_agent_id) && (await alertsOf(p)).some((a) => a.title.includes("Question")) && (await tagsOf(p)).includes("Question"));
    await text(p, "aur ek baat, commission kaise track hoga?");
    await sleep(5000);
    check("a second question doesn't get a second bot reply (once per 24h)", (await sent(p)).length === 3);
  }),

  scenario(9, "Video nudge N1 (timer shortened to 1 min for test numbers)", async () => {
    await setOverrides({ nudge_delay_minutes: 1, working_hours_mode: "open" });
    const go = async (p) => {
      await text(p, EN_PREFILL);
      await waitSent(p, 1);
      await tap(p, "v2.e1.dsa", "I run a DSA business");
      await waitSent(p, 2);
      await tap(p, "v2.e3.solo", "Just me");
      await waitSent(p, 3);
      await tap(p, "v2.e4a.video", "Watch video first");
      await waitSent(p, 4);
    };
    const [a, b, c] = [P(14), P(15), P(16)];
    await Promise.all([go(a), go(b), go(c)]);
    // b: the lead writes in the meantime; c: an agent does.
    await text(b, "ok dekh liya");
    const convC = await convOf(c);
    await db.from("messages").insert({ conversation_id: convC.id, sender_type: "agent", content_type: "text", content_text: "[TEST] agent: Hi, I'm calling you now", status: "sent", message_id: `wamid.TEST.agent.${randomUUID()}` });
    await sleep(65000);
    const tick = await fetch(`${BASE}/api/flows/tick`, { method: "POST", headers: { "x-push-secret": env.PUSH_DISPATCH_SECRET } });
    const tickBody = await tick.json();
    current.log.push(`tick: ${JSON.stringify(tickBody.processed?.map((j) => `${j.status}: ${j.result}`))}`);
    await sleep(3000);
    const sa = await sent(a);
    check("N1 arrives after the delay", sa.at(-1) === "n1", sa.join(" → "));
    const sb = await sent(b);
    check("N1 cancelled because the lead messaged", !sb.includes("n1"), sb.join(" → "));
    const sc = await sent(c);
    check("N1 cancelled because an agent messaged", !sc.includes("n1"), sc.join(" → "));
    await tap(a, "v2.n1.demo", "Yes, book demo");
    const s2 = await waitSent(a, 6);
    check("N1 'Yes, book demo' → slot picker", s2.at(-1) === "e5");
    await setOverrides({ nudge_delay_minutes: undefined, working_hours_mode: "auto" });
  }),

  scenario(10, "Agent active in the last 72h → bot stays out", async () => {
    const p = P(17);
    // An existing lead the agent is already talking to.
    const { data: c } = await db.from("contacts").insert({ account_id: ACCOUNT, user_id: OWNER, phone: p, name: "[TEST] live demo lead" }).select("id").single();
    const { data: conv } = await db.from("conversations").insert({ account_id: ACCOUNT, user_id: OWNER, contact_id: c.id, status: "open", assigned_agent_id: POOL[0] }).select("id").single();
    await db.from("messages").insert({ conversation_id: conv.id, sender_type: "customer", content_type: "text", content_text: "Hi", status: "delivered", message_id: `wamid.TEST.old.${randomUUID()}`, created_at: new Date(Date.now() - 3 * 3600_000).toISOString() });
    await db.from("messages").insert({ conversation_id: conv.id, sender_type: "agent", content_type: "template", content_text: "[TEST] Demo link for today 5 PM", status: "sent", message_id: `wamid.TEST.agent.${randomUUID()}`, created_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    await text(p, "Hi, ok joining");
    await sleep(6000);
    const s = await sent(p);
    check("v2 does NOT start / restart", s.length === 0 && (await runsOf(p)).length === 0, s.join(","));
    const { data: inbound } = await db.from("messages").select("content_text").eq("conversation_id", conv.id).eq("sender_type", "customer").order("created_at");
    const after = await convOf(p);
    check("the message lands in the agent's chat, still assigned to them", inbound.at(-1).content_text === "Hi, ok joining" && after.assigned_agent_id === POOL[0], agentName(after.assigned_agent_id));
  }),

  scenario(11, "Round-robin across 6 new leads started at the same time", async () => {
    const ps = [P(18), P(19), P(20), P(21), P(22), P(1).replace(/01$/, "23")];
    await setSettings({ test_phones: [...new Set([...PHONES, ...ps])], dry_run_phones: [...new Set([...PHONES, ...ps])] });
    await Promise.all(ps.map((p) => text(p, EN_PREFILL)));
    await Promise.all(ps.map((p) => waitSent(p, 1)));
    await Promise.all(ps.map((p) => tap(p, "v2.e1.dsa", "I run a DSA business")));
    await Promise.all(ps.map((p) => waitSent(p, 2)));
    const assigned = await Promise.all(ps.map(async (p) => (await convOf(p)).assigned_agent_id));
    const counts = POOL.map((id) => assigned.filter((a) => a === id).length);
    current.log.push(`assignments: ${assigned.map(agentName).join(", ")}`);
    check("split 3 / 3 across Deepa and Purushottam", counts[0] === 3 && counts[1] === 3, counts.join(" / "));
    check("every chat has exactly one pool agent", assigned.every((a) => POOL.includes(a)));
  }),

  scenario(12, "Old flow still runs for numbers not on the test list", async () => {
    if (!OLD_FLOW) return check("old flow id given", false);
    await text(OLD_PHONE, "hi");
    await sleep(8000);
    const v2Runs = await runsOf(OLD_PHONE);
    const oldRuns = await runsOf(OLD_PHONE, OLD_FLOW);
    const ev = await events(OLD_PHONE, OLD_FLOW);
    current.log.push(`old-flow events: ${ev.map((e) => `${e.event_type}${e.node_key ? `:${e.node_key}` : ""}${e.payload?.reason ? `(${e.payload.reason})` : ""}`).join(" → ")}`);
    check("no v2 run for a non-test number", v2Runs.length === 0);
    check("the old flow started its run (keyword 'hi') exactly as before", oldRuns.length === 1 && ev.some((e) => e.event_type === "started"));
    check("old flow tried its first step (send fails only because the number is fake)", ev.some((e) => e.node_key === "send_list"));
  }),
];

// ---------------------------------------------------------------- run
async function cleanup() {
  const phones = [...PHONES, P(1).replace(/01$/, "23"), OLD_PHONE];
  const { data: contacts } = await db
    .from("contacts")
    .select("id")
    .eq("account_id", ACCOUNT)
    .or(phones.map((p) => `phone.like.%${p.slice(-10)}`).join(","));
  const ids = (contacts ?? []).map((c) => c.id);
  if (ids.length) {
    await db.from("flow_runs").delete().in("contact_id", ids);
    await db.from("deals").delete().in("contact_id", ids);
    await db.from("contacts").delete().in("id", ids);
  }
  await db.from("round_robin_pointers").update({ last_agent_id: ORIGINAL_POINTER }).eq("account_id", ACCOUNT).eq("pool_key", poolKey);
  await db.from("flow_engine_settings").update({ settings: ORIGINAL_SETTINGS }).eq("flow_id", FLOW);
  return ids.length;
}

await cleanup(); // start clean
const ALL_SIM = [...PHONES, P(1).replace(/01$/, "23"), OLD_PHONE];
await setSettings({
  test_phones: PHONES,
  dry_run_phones: PHONES,
  sim_phones: ALL_SIM,
  routing: "test",
  test_overrides: { working_hours_mode: "auto" },
});

for (const s of scenarios) {
  if (ONLY && !ONLY.includes(s.n)) continue;
  current = { n: s.n, title: s.title, checks: [], log: [], failed: false };
  results.push(current);
  const t0 = Date.now();
  try {
    await s.fn();
  } catch (err) {
    current.failed = true;
    current.checks.push({ label: "scenario ran", ok: false, detail: err.message });
  }
  // Any action that failed inside the engine shows up here.
  const errs = [];
  for (const p of [...PHONES, OLD_PHONE]) {
    const c = await contactOf(p);
    if (c) errs.push(...(await errors(p)).map((e) => `${p.slice(-3)} ${e}`));
  }
  current.engineErrors = errs;
  current.seconds = Math.round((Date.now() - t0) / 1000);
  console.log(`${current.failed ? "FAIL" : "PASS"}  ${s.n}. ${s.title} (${current.seconds}s)`);
  for (const c of current.checks) console.log(`   ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? `  [${c.detail}]` : ""}`);
  for (const l of current.log) console.log(`   · ${l}`);
}

const deleted = KEEP ? 0 : await cleanup();
if (KEEP) await db.from("flow_engine_settings").update({ settings: ORIGINAL_SETTINGS }).eq("flow_id", FLOW);

const md = [
  `# DSA Welcome v2 — end-to-end test results`,
  ``,
  `Run: ${new Date().toISOString()} against ${BASE}. Simulated Meta-signed webhooks for test numbers; bot replies written to the inbox but not sent to Meta (dry-run test numbers). ${KEEP ? "Data kept." : `Cleaned up ${deleted} test contacts afterwards.`}`,
  ``,
  ...results.flatMap((r) => [
    `## ${r.failed ? "❌" : "✅"} ${r.n}. ${r.title} (${r.seconds}s)`,
    ...r.checks.map((c) => `- ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? ` — \`${c.detail}\`` : ""}`),
    ...r.log.map((l) => `- · ${l}`),
    ...(r.engineErrors?.length ? [`- engine errors logged so far: ${r.engineErrors.map((e) => `\`${e}\``).join("; ")}`] : []),
    ``,
  ]),
].join("\n");
writeFileSync(OUT, md);
console.log(`\n${results.filter((r) => !r.failed).length}/${results.length} scenarios passed — ${OUT}`);
process.exit(results.some((r) => r.failed) ? 1 : 0);
