# DSA Welcome v3 — changes, switch & rollback

**Status:** v3 (`58065faf-eff4-43fe-8ab0-898a8be68c17`) is installed in **test mode**. Only the test numbers 919000000201–230 reach it. v2 (`fcca58b4-…`) is still **live** for everyone else.

## Switch on / roll back (one setting)

Go to Flows → *DSA Welcome v3* → Runs → **Routing** card.

- **Live**: v3 handles all traffic. The newest live flow wins, so v2 stops getting new leads.
- **Test**: rolls back immediately. v2 is live again for everyone, and v3 only sees the test numbers.

v2 config is untouched, and `supabase/flows/dsa-welcome-v2.json` is kept. Leads already in v3 keep their tags, deals and follow-ups after a rollback, and their next message goes through v2.

## What changed (by spec item)

| # | Change | Where |
|---|---|---|
| 1 | New EN/HI welcome with image header; buttons *Yes, I'm a DSA / No, need DSA code / हिंदी में बताएं* | `supabase/flows/genflow_v3.py` → `dsa-welcome-v3.json` (nodes `e1`, `h1`); `meta-api.ts` `sendInteractiveButtons(headerImageUrl)`; `message-bubble.tsx` shows the header |
| 2 | Round-robin assignment on the first message; keeps an existing pool agent | `start` node `assign` action; webhook skips inbox auto-assign when the flow owns assignment (`v2OwnsAssignment`) |
| 3 | Text at the welcome: price → price line + team size; anything else → fallback + video + agent alert + welcome again (once) | `engine.ts` `handleText` (`entry_fallback_nodes`, `vars.entry_reshown`); nodes `price_en/hi`, `e8w/h8w` |
| 4 | Button taps always answered during the 72h bot pause | `settings.taps_bypass_pause`; `v3.ts` `pauseBlocks` |
| 5 | Step nudges (welcome 45m, team 1h, plan 2h, slot 30m, video 2h), max 2, quiet hours 21:00–10:00 → 10:30, template outside 24h, final hand-over follow-up *No reply after 2 nudges – call {name}* + stop automation, cancelled on reply/agent message/booking/No-need-code | `settings.nudges`; `engine.ts` `schedule_nudge`, `processJob`; `v3.ts` `shiftOutOfQuietHours`, `canSendNudge` |
| 6 | Slot **list**: 30-min slots, up to 6 over 2 working days, capacity 2, *Call me instead* / *Other time*, last of two picks within 10s wins, meeting follow-up at slot −15 min | migration `062` (`flow_slot_bookings`, `flow_book_slot`); `v3.ts` `computeListSlots`; `engine.ts` `bookSlot`, `freeListSlots`; nodes `e5/h5`, `e5_full`, `e5_done`, `e_other` |
| 7 | Video only at Call me, fallback, demo-day reminder (10:00, or 2h before a pre-noon slot) and confirmation | nodes `e6/h6`, `e8w`, `rem_en/rem_hi`, `e5_done`; `schedule_reminder`, `v3.ts` `demoReminderDue` |
| 8 | Agent name = first name of the pool assignee, else "our team" | `settings.agent_name_pool_only`, `agent_intro`; `v3.ts` `agentNameFor` |
| 9 | Post-video *Yes, I want this / I have a question / Not for me*; plan by team size → registration + payment links, *Ready to Buy*, deal value, **Payment Pending** stage, onboarding follow-up, urgent alert; Not-for-me reasons → Lost: tags; *No thanks* closes | nodes `n1/h_n1`, `ready_route`, `r_solo/r_team/e3r`, `pay_*`, `e_q`, `e_not`, `lost_*`, `no_thanks`; actions `set_deal_value`, `move_deal_stage`, `flag_hot`; stage added by migration `062` |
| 10 | Tag rules; *Oops, I am a DSA* removes *Lost: Not-DSA*; Call me / Book demo / Yes remove all `Lost:` tags | `remove_tag` with `Lost:*`; `v3.ts` `tagMatches` |
| 11 | Demo already booked + old button → *Your demo is already booked for {slot} ✅* with Change time / Call me | `settings.booking_lock`; nodes `booked_en/h_booked` |
| 12 | No reply-time promises (shortly / tomorrow, जल्द ही / कल) | all copy; the generator rejects banned phrases |

Prices, links, slot times, timers, agent pool and templates all live in the flow config and `flow_engine_settings`. None of them are hard-coded in the engine.

**Failures are logged.** Every failed action (tag, assign, deal, follow-up, scheduled message, template send) is written as an `error` event on the flow run and appears in Runs history.

**Deviation:** the header image uses a public Supabase Storage URL, not a WhatsApp media ID, because media IDs expire after 30 days.

## Templates (nudges/reminders outside the 24h window)

| Name | Lang | Category | Status |
|---|---|---|---|
| dsa_nudge_welcome / _hi | en / hi | Marketing | Pending at Meta |
| dsa_nudge_team / _hi | en / hi | Marketing | Pending |
| dsa_nudge_plan / _hi | en / hi | Marketing | Pending |
| dsa_nudge_slot / _hi | en / hi | Marketing | Pending |
| dsa_nudge_video / _hi | en / hi | Marketing | Pending |
| dsa_demo_reminder | en | Utility | Pending |
| dsa_demo_reminder_hi | hi | Utility | **Draft — Meta returned "Invalid parameter"; resubmit from Templates page** |

Inside 24h the bot sends normal interactive messages. Outside 24h it uses these templates, or skips the send and logs it if a template isn't approved yet.

## Tests

- Unit and builder tests: `src/lib/flows/v2/v3.test.ts`, `logic.test.ts`, `builder-compat.test.ts`. DB concurrency: `db.int.test.ts` (opt-in). The full suite passes.
- End-to-end, 15 scenarios: `node scripts/simulate-flow-v3.mjs --flow <v3 id>` → results in `docs/flow-v3-test-results.md`.
