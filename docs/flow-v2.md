# DSA Welcome v2 and flow engine v2

## What was built

- **Engine v2** in `src/lib/flows/v2/`. It is used only by flows that have a row in `flow_engine_settings`.
  - Every other flow, including the current "Welcome menu", still runs on the original engine (`src/lib/flows/engine.ts`) with no behaviour change.
  - The only change to the original engine is one call at the top of `dispatchInboundToFlows`. It hands a contact to v2 when v2's routing covers that contact, and otherwise falls through unchanged.
- **DSA Welcome v2**: 23 steps covering the English and Hindi paths, defined in `supabase/flows/dsa-welcome-v2.json`.
  - Installed with `scripts/install-flow-v2.mjs`.
  - Status is `active` with trigger `manual`, so the original engine never starts it.
  - Routing is `test`, so only allow-listed numbers get it.
- **Traffic switch**: open Flows → DSA Welcome v2 → **Runs**. The **Traffic routing** card has three modes:
  - **Off**: the original flow handles everyone.
  - **Test numbers only**: v2 handles only the listed numbers. Everyone else stays on the original flow.
  - **Live, everyone**: v2 handles all contacts.
    - Any active run of the old flow for a contact v2 takes over is ended with the reason `superseded_by_v2`.
    - The old flow then gets no new contacts.
  - Switching back to Test or Off takes effect on the next message.
  - The same switch is available as an API: `PUT /api/flows/<id>/routing {"routing":"live"|"test"|"off","test_phones":[…]}`. It is admin-only.
- **Scheduled steps** (the N1 video nudge and auto-closing E2 after 24 hours) are stored in `flow_scheduled_jobs`.
  - pg_cron calls `/api/flows/tick` every minute, but only when a job is due.
  - The call is authenticated with `PUSH_DISPATCH_SECRET`.
- **Notifications**: a new notification type, `flow_alert`, is sent for demo booked, call requested and question asked.
  - It appears in the in-app bell.
  - It is also pushed to the agent's phone through the existing notifications push trigger.
- **Drop-off report**: run `select * from flow_dropoff_by_day(14);` in the Supabase SQL editor.
  - It returns one row per day, flow and last step reached, with a run count and the median minutes to the first human reply.
  - It shows v2 and the old flow side by side.

## No hard-coded business data

Phone numbers, prices, agent ids, working hours, the pipeline name, form field names and the Hindi ad text all live in one of two places:
- the flow's node config (the copy and the deal values), or
- `flow_engine_settings.settings` (everything else).

The code reads them from there.

## Root causes and fixes

| # | Problem | Root cause (original engine) | Fix (v2) |
|---|---|---|---|
| 2 | A second tap, or a tap on an earlier message's button, is ignored | `handleReplyForActiveRun` compares the tap only with the **current** step (`matchReplyId(currentNode, …)`), so a button from an earlier message never matches. It falls through to the reprompt fallback (46 reprompts on 8–16 Oct). After the run ends, `findEntryFlow` only starts on a keyword match, so the tap goes nowhere. The old flow also reuses the reply ids `yes`, `btn_2` and `btn_3` on several steps, so matching by id alone would be ambiguous. | `resolveTap` (`v2/logic.ts`) looks up the tap across the **whole** flow. v2 reply ids are unique (`v2.<step>.<button>`). Taps on old-flow buttons are matched by their visible title. A finished run is reopened by a tap (`reopenRun`). |
| 3 | Form submissions never start the flow | The webhook turns an `nfm_reply` into the text "📝 Form submitted…". The old flow only starts on the keywords `support`, `help` and `hi`, so nothing starts and nothing is assigned. | The webhook passes the form JSON to the engine (`form` on `DispatchInboundInput`). v2 starts once, stores `screen_0__0` as the contact's name (set by `form.field_map`), and stores the email when present. |
| 4 | The Hindi ad text gets no reply | `matchesKeywordTrigger` with the keywords hi/help/support: Devanagari text contains none of them. | Entry no longer depends on keywords (`decideEntry`). `detectLanguage` picks Hindi when the text has Devanagari, matches a configured Hindi pre-fill, or the form says Hindi. |
| 5 | Duplicate replies | The original engine detects a race only **after** sending (`advanceCurrentNodeKey` returns false, which shows 7 times as `lost_race_during_advance` in production). By then both replies have gone out. A form and a text are two messages, and each one evaluates the trigger. | `flow_record_tap` and a debounce mean that of two taps close together, only the latest is processed. `flow_claim_step` (an atomic upsert) means the same step is never sent twice within 10 s. The unique-active-run index means a form and a text arriving together start one run. |
| 6 | Free text after the flow goes nowhere | There is no active run and no keyword, so nothing happens. With an active run, the bot resends the same buttons, then hands off without assigning or notifying anyone. 144 old runs are stuck `active`, because `/api/flows/cron` (the stale-run sweep) is not scheduled anywhere. Those contacts' messages hit the reprompt loop. | `fallback()` assigns an agent by round-robin, notifies them, tags `Question`, and replies with E8/H8 **once per 24 h**. Then it waits for the human. Text that clearly answers the open question (team size, price) is treated as the matching button (`text_intents`). |
| 7 | The flow restarts mid-demo | The keyword `hi` with `contains` matching fires on any message that contains "hi" ("this", "anything", a reply to an agent's template) from any contact without an active run. Nothing checks for a human agent. | `decideEntry` stays out when a human agent messaged within 72 h (`agent_active`). It never restarts within 30 days of a finished run. The bot pause also blocks taps while an agent is active. |
| 10 | Button actions don't run | Actions were separate `set_tag` and `handoff` steps after the message. A failed tag was logged, but assignment only happened at the very end, and 3 `set_tag_failed` errors remain in production. | Actions are attached to the step itself (`actions` in the node config) and run when the step is entered. Every success is a `node_entered` event and every failure is an `error` event in the run history. Testing caught a real bug this way: `deals.assigned_to` references `profiles.id`, not the user id. It is fixed. |

## Engine v2 behaviour (settings)

| Setting | Value | Meaning |
|---|---|---|
| `entry.reengage_after_days` | 30 | An existing contact silent this long gets the welcome again |
| `entry.skip_if_agent_active_hours` | 72 | No start or restart while a human agent is active |
| `entry.skip_if_run_finished_days` | 30 | No restart after a finished run |
| `bot_pause_hours` | 72 | Bot silent after a human agent message (N1 is also cancelled by an agent message, per its own rule) |
| `tap_debounce_seconds` | 4 | Taps within this window: only the last is answered |
| `dedupe_window_seconds` | 10 | The same step is never sent twice within this window |
| `fallback_reply_cooldown_hours` | 24 | E8/H8 is sent at most once per window |

**Why the debounce is 4 s and not 10 s.** Every tap is held for the debounce window before the bot answers. Holding each tap for 10 s would make every button feel slow. With 4 s:
- two quick taps get one reply (the last tap);
- the same step can never be sent twice within 10 s;
- taps more than 4 s apart are both answered, and the latest one decides where the lead ends up.

To use 10 s, set `tap_debounce_seconds` to 10.

## Test results

All 12 scenarios passed end to end against the deployed app (16 Oct 2026). Details are in `docs/flow-v2-test-results.md`. No engine errors were logged.

Two issues were found and fixed during testing:
- **Deal owner:** `deals.assigned_to` references `profiles.id`, not the user id.
- **Inbox auto-assign:** it was assigning every new chat on the first message, with "prefer online agents" on. That broke "E2 stays unassigned" and sent every lead to whichever agent was online. For contacts v2 handles, v2 now does the assigning: at E3/H3, E5, E6 or E8, by strict round-robin. To keep the inbox auto-assign for v2 contacts as well, set `respect_inbox_auto_assign: true`.


- **N1 when the 24 h window has closed**: no approved template is configured yet (`nudge_template` is null), so N1 is skipped in that case and the job shows the reason. To fix this, create the template in Meta and set `nudge_template: {name, language}`.
- **Hiding busy demo slots**: there is no calendar data in the CRM, so all three slots are always shown.
- **"Demo Booked" stage**: created at the end of "Sales Pipeline", after Won, so that no existing stage was touched. Drag it to the right place in the pipeline.
- **E6 off-hours copy** says "tomorrow" as the spec does. On a Saturday evening the follow-up is correctly set for Monday at 10:00.
- **Existing `nurture` tag**: it is reused, because tag names are matched case-insensitively. No second "Nurture" tag is created.
- **Builder editing**: v2 steps carry extra config (`actions`, `dynamic_slots`, `text_off_hours`). Edit them in `supabase/flows/dsa-welcome-v2.json` and re-run the installer, not in the visual builder.

## Running the tests

- Unit tests: `npx vitest run src/lib/flows/v2`.
- Database concurrency tests (they create `[TEST]` rows and clean them up):
  ```
  FLOW_INT_DB=1 FLOW_INT_POOL=<id>,<id> npx vitest run src/lib/flows/v2/db.int.test.ts
  ```
- End-to-end, against the deployed app:
  ```
  node scripts/simulate-flow-v2.mjs --base https://<app> --flow <v2 id> --old-flow <old id>
  ```
  It uses fake numbers 9190000001xx. They are dry-run numbers, so nothing is sent to Meta, and everything is deleted afterwards.
