#!/usr/bin/env node
/**
 * Create the webinar broadcasts as paced ("drip") broadcasts
 * (migration 063, /api/broadcasts/drip). Nothing is sent by this script;
 * the drip sender picks them up at their scheduled time.
 *
 *   node scripts/create-webinar-broadcasts.mjs invite
 *   node scripts/create-webinar-broadcasts.mjs reminders --link https://meet.google.com/xxx
 *
 * invite    → everyone (except blocked, Lost:*, Not Interested, Won), from
 *             Mon 19 Oct 10:00 IST, 1 message every 2 min, 10:00–19:00,
 *             max 250 a day; Hindi leads get the Hindi template.
 * reminders → only contacts tagged "Webinar Registered" at send time:
 *             day-before (21 Oct 19:00), 1 hour before (22 Oct 08:00),
 *             live now (22 Oct 08:58).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");

const argv = process.argv.slice(2);
const what = argv[0];
const link = argv.includes("--link") ? argv[argv.indexOf("--link") + 1] : null;
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: owner } = await db.from("profiles").select("user_id, account_id").eq("account_role", "owner").limit(1).single();

const IST = (s) => new Date(`${s}+05:30`).toISOString();
const BANNER = (
  await db.from("message_templates").select("header_media_url").eq("name", "dsa_webinar_invite_en").single()
).data?.header_media_url;

const plans = [];
if (what === "invite") {
  plans.push({
    name: "Webinar invite (22 Oct)",
    scheduled_at: IST("2026-10-19T10:00:00"),
    drip: {
      per_tick: 1,
      every_minutes: 2,
      window: { timezone: "Asia/Kolkata", start: "10:00", end: "19:00" },
      daily_cap: 250,
      templates: {
        en: { name: "dsa_webinar_invite_en", language: "en_US", header_media_url: BANNER },
        hi: { name: "dsa_webinar_invite_hi", language: "hi" },
      },
      params: ["{first_name}"],
      audience: { exclude_tags: ["Lost:*", "Not Interested", "Webinar: Not interested"], exclude_stages: ["Won"] },
    },
  });
} else if (what === "reminders") {
  if (!link) throw new Error("--link <webinar joining link> is required");
  const reminder = (name, at, base) => ({
    name,
    scheduled_at: IST(at),
    drip: {
      per_tick: 40,
      every_minutes: 1,
      templates: { en: { name: base, language: "en" }, hi: { name: `${base}_hi`, language: "hi" } },
      params: ["{first_name}", link],
      audience: { tag: "Webinar Registered" },
    },
  });
  plans.push(
    reminder("Webinar reminder – day before", "2026-10-21T19:00:00", "dsa_webinar_reminder_day"),
    reminder("Webinar reminder – 1 hour", "2026-10-22T08:00:00", "dsa_webinar_reminder_hour"),
    reminder("Webinar – live now", "2026-10-22T08:58:00", "dsa_webinar_live_now"),
  );
} else {
  throw new Error("usage: invite | reminders --link <url>");
}

for (const p of plans) {
  const { data, error } = await db
    .from("broadcasts")
    .insert({
      account_id: owner.account_id,
      user_id: owner.user_id,
      name: p.name,
      template_name: p.drip.templates.en.name,
      template_language: p.drip.templates.en.language,
      status: "scheduled",
      scheduled_at: p.scheduled_at,
      total_recipients: 0,
      drip: p.drip,
    })
    .select("id")
    .single();
  if (error) throw error;
  console.log(`scheduled: ${p.name} @ ${p.scheduled_at} (${data.id})`);
}
