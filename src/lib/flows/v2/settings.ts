/**
 * Settings for flows that run on the v2 engine. Stored per flow in
 * `flow_engine_settings.settings` (migration 057). Every business value
 * — agent pool, working hours, test numbers, form field names — lives
 * here or in the flow's node config, never in code.
 */

export type V2Routing = "off" | "test" | "live";
export type V2Lang = "en" | "hi";

export interface WorkingHours {
  /** IANA zone, e.g. "Asia/Kolkata". */
  timezone: string;
  /** ISO weekdays that are working days: 1 = Monday … 7 = Sunday. */
  days: number[];
  /** "HH:MM" local start / end. */
  start: string;
  end: string;
}

export interface TextIntent {
  /** Lower-cased substrings; any hit matches. */
  keywords: string[];
  /** Only active while the run waits on one of these nodes (empty = anywhere). */
  at_nodes?: string[];
  /** Target node per language. */
  target: Partial<Record<V2Lang, string>>;
  /**
   * Optional: pick the target from a run var instead, e.g.
   * { var: "plan", map: { individual: { en: "e4a", hi: "h4a" } } }.
   * Falls back to `target` when the var is unset.
   */
  by_var?: { var: string; map: Record<string, Partial<Record<V2Lang, string>>> };
}

export interface V2Settings {
  engine: "v2";
  routing: V2Routing;
  /** Phone numbers (any format) that get v2 while routing = "test". */
  test_phones: string[];
  /**
   * Test numbers the engine must NOT really message (simulated contacts).
   * Bot messages to them are written to the inbox but never sent to Meta.
   */
  dry_run_phones?: string[];
  /** The flow v2 replaces; its active runs end when v2 takes a contact. */
  replaces_flow_id?: string | null;

  /** Entry node per language. */
  entry_nodes: Record<V2Lang, string>;
  /** Fallback (question) node per language. */
  fallback_nodes: Record<V2Lang, string>;
  /** Slot-picker node per language (old "Book free demo" taps land here). */
  working_hours: WorkingHours;

  /** Round-robin pool (user ids). */
  agent_pool: string[];
  skip_offline?: boolean;
  /** Keep the inbox's auto-assign-on-first-message for v2 contacts. Default false: v2 assigns. */
  respect_inbox_auto_assign?: boolean;
  /** Shown as {{agent_first_name}} when no agent is assigned yet. */
  fallback_agent_name: Record<V2Lang, string>;

  entry: {
    /** Re-start for an existing contact silent for this many days. */
    reengage_after_days: number;
    /** Don't start while an agent sent a human message within this window. */
    skip_if_agent_active_hours: number;
    /** Don't restart when a v2 run finished within this many days. */
    skip_if_run_finished_days: number;
    /** Text arriving this soon after the welcome is treated as part of it. */
    opening_grace_seconds: number;
  };

  language: {
    /** Pre-filled ad texts that mean "Hindi". Compared loosely. */
    hindi_prefill: string[];
    /** Contact custom field that stores en/hi. */
    contact_field: string;
  };

  form: {
    /** Meta form field key → contact column ("name" | "email"). */
    field_map: Record<string, "name" | "email">;
    /** Form field whose value says the language ("hi"/"hindi"/"हिंदी"). */
    language_field?: string | null;
  };

  dedupe_window_seconds: number;
  /** Taps within this window: only the latest is processed. */
  tap_debounce_seconds: number;
  bot_pause_hours: number;
  /** The question/fallback reply is sent at most once per this window. */
  fallback_reply_cooldown_hours: number;

  text_intents: TextIntent[];

  deal: { pipeline: string; new_stage: string; currency: string };

  /** Approved template used for nudges when the 24h window has closed. */
  nudge_template?: { name: string; language: string } | null;

  // ---- Optional behaviours (v3). Absent = the original v2 behaviour. ----

  /** Lead's button taps are answered even while the bot is paused for an agent. */
  taps_bypass_pause?: boolean;
  /** Only ignore text right after the welcome when the run started from a form. */
  opening_grace_after_form_only?: boolean;
  /**
   * Free text at the welcome step (no intent matched): this node replies
   * (fallback + video) and then shows the welcome again — once per run.
   */
  entry_fallback_nodes?: Record<V2Lang, string>;
  /** {{agent_first_name}} / {{agent_intro}} only name an agent from agent_pool. */
  agent_name_pool_only?: boolean;
  /** {{agent_intro}}: "{{name}} from our team" when named, else the "none" text. */
  agent_intro?: Record<V2Lang, { named: string; none: string }>;
  /** Step nudges: cap, quiet hours, out-of-window templates, final hand-over. */
  nudges?: {
    max_per_lead: number;
    /** "HH:MM" local; no automated nudge between quiet_start and quiet_end. */
    quiet_start: string;
    quiet_end: string;
    /** Local time a nudge that fell in quiet hours is moved to. */
    shift_to: string;
    /** After the last allowed nudge, run final_actions if still silent this long. */
    final_after_hours: number;
    final_actions: unknown[];
    /** Nudge node → approved template used when the 24h window has closed. */
    templates?: Record<string, { name: string; language: string }>;
    /**
     * Second nudge per step: first-nudge node → follow-up node, sent
     * `followup_after_hours` later if the lead is still silent. The final
     * hand-over then follows the follow-up instead of the lead-wide cap.
     */
    followups?: Record<string, string>;
    followup_after_hours?: number;
  };
  /** Max bookings per demo slot (list-mode slot pickers). */
  slot_capacity?: number;
  /** Taps on these steps while a future demo is booked go to `redirect` instead. */
  booking_lock?: { nodes: string[]; redirect: Record<V2Lang, string> };
  /** Demo-day reminder template per language (when the 24h window has closed). */
  reminder_templates?: Record<V2Lang, { name: string; language: string }>;
  /** Also count finished runs of these flows when deciding whether to restart. */
  history_flow_ids?: string[];

  /** Only applied to contacts on the test allow-list. */
  test_overrides?: {
    nudge_delay_minutes?: number;
    no_reply_delay_minutes?: number;
    /** Final hand-over after the last nudge, in minutes (instead of hours). */
    final_after_minutes?: number;
    /** Demo-day reminder this many minutes after booking (instead of the real time). */
    reminder_after_minutes?: number;
    /** Skip quiet-hours shifting (so timers can be tested at any hour). */
    ignore_quiet_hours?: boolean;
    /** "open" / "closed" forces working hours for test contacts. */
    working_hours_mode?: "auto" | "open" | "closed";
  };
}

export interface V2Bundle {
  flow: { id: string; status: string; created_at: string };
  settings: V2Settings;
}

/**
 * Which v2 flow handles this phone: a flow in test mode that lists the
 * number wins (so changes can be tried on test numbers while another
 * flow is live); otherwise the newest live flow. Switching a newer flow
 * to live therefore takes over from the older one, and switching it back
 * to test hands traffic back — that is the rollback.
 */
export function pickBundle<T extends V2Bundle>(bundles: T[], phone: string | null | undefined): T | null {
  const active = bundles.filter((b) => b.flow.status === "active");
  const test = active.find((b) => b.settings.routing === "test" && phoneInList(phone, b.settings.test_phones));
  if (test) return test;
  const live = active
    .filter((b) => b.settings.routing === "live")
    .sort((a, b) => Date.parse(b.flow.created_at) - Date.parse(a.flow.created_at));
  return live[0] ?? null;
}

/** Last 10 digits — compares Indian numbers regardless of +91 / 0 / spaces. */
export function phoneKey(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function phoneInList(phone: string | null | undefined, list: string[] | undefined): boolean {
  const key = phoneKey(phone);
  if (!key) return false;
  return (list ?? []).some((p) => phoneKey(p) === key);
}

/** Does v2 handle this contact under the current routing? */
export function v2AppliesTo(settings: V2Settings, phone: string | null | undefined): boolean {
  if (settings.routing === "live") return true;
  if (settings.routing === "test") return phoneInList(phone, settings.test_phones);
  return false;
}

export function isTestContact(settings: V2Settings, phone: string | null | undefined): boolean {
  return phoneInList(phone, settings.test_phones);
}
