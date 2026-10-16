# DSA Welcome v2 — end-to-end test results

Run: 2026-10-16T08:39:01.425Z against https://wacrm-jet-two.vercel.app. Simulated Meta-signed webhooks for test numbers; bot replies written to the inbox but not sent to Meta (dry-run test numbers). Cleaned up 24 test contacts afterwards.

## ✅ 1. English happy path → demo booked (94s)
- ✓ steps e1 → e3 → e4a → e5 → e5_done — `e1 → e3 → e4a → e5 → e5_done`
- ✓ tags Contacted, Price Sent, Demo Booked — `Contacted, Demo Booked, Price Sent`
- ✓ assigned to a pool agent — `Purushottam Kumar`
- ✓ one deal, value 600, stage Demo Booked, Sales Pipeline — `[{"value":600,"stage":"Demo Booked"}]`
- ✓ demo follow-up for the agent at slot − 15 min — `Demo – Fri 16 Oct, 5–7 PM – Individual @ 2026-10-16T11:15:00+00:00`
- ✓ agent notified (in-app; push goes via the notification trigger) — `New conversation assigned; [TEST] 📅 Demo booked: [TEST] 101`
- ✓ confirmation names the slot + agent first name
- · slot buttons offered: Today 5–7 PM · Tomorrow 11 AM–1 PM · Tomorrow 5–7 PM
- · confirmation: "Done ✅ Your demo is booked for Fri 16 Oct, 5–7 PM. Purushottam from our team will send the Google Meet link 10 min before. 🙂"

## ✅ 2. Hindi ad text → Hindi welcome → team plan → call me (in hours + off hours) (142s)
- ✓ [open] Hindi welcome sent directly (no language step) — `h1`
- ✓ [open] steps h1 → h3 → h4b → h6 — `h1 → h3 → h4b → h6`
- ✓ [open] 30-minute copy
- ✓ [open] deal value 1397
- ✓ [open] call follow-up ≈ +30 min — `2026-10-16T08:54:44.163+00:00`
- ✓ [open] tags Contacted, Price Sent, Call Requested — `Call Requested, Contacted, Price Sent`
- ✓ [open] chat marked pending (top of queue) + agent notified
- ✓ [open] flow_language = hi on the contact
- ✓ [closed] Hindi welcome sent directly (no language step) — `h1`
- ✓ [closed] steps h1 → h3 → h4b → h6 — `h1 → h3 → h4b → h6`
- ✓ [closed] tomorrow 10–11 copy
- ✓ [closed] deal value 1397
- ✓ [closed] call follow-up next working day 10:00 IST — `2026-10-17T04:30:00+00:00`
- ✓ [closed] tags Contacted, Price Sent, Call Requested — `Call Requested, Contacted, Price Sent`
- ✓ [closed] chat marked pending (top of queue) + agent notified
- ✓ [closed] flow_language = hi on the contact
- · [open] reply: "ज़रूर! हमारी team से Deepa 30 मिनट के अंदर आपको call करेंगे। कृपया ये number reachable रखें 📞"
- · [closed] reply: "धन्यवाद! हमारी team कल सुबह 10–11 बजे आपको call करेगी 📞"

## ✅ 3. Language switch both ways (94s)
- ✓ EN welcome → हिंदी में बताएं → rest in Hindi — `e1 → h1 → h3`
- ✓ HI welcome → English please → rest in English — `h1 → e1 → e3`
- ✓ run language follows the switch

## ✅ 4. Mis-tap recovery + latest tap wins (77s)
- ✓ Lost: Not-DSA tag
- ✓ chat left unassigned on the not-a-fit step
- ✓ 24h auto-close scheduled — `auto_close @ 2026-10-17T08:28:05.237+00:00`
- ✓ e1 → e2 → e3 → e2 (old button tapped again → E2 again) — `e1 → e2 → e3 → e2`
- ✓ assigned once they said they're a DSA (E3) — `Deepa Tyagi`

## ✅ 5. Tap an older message's button from the video step (92s)
- ✓ e7 (video) → tap 'Book free demo' on the plan message → e5 slot picker — `e1 → e3 → e4a → e7 → e5`
- ✓ Nurture tag — `Contacted, Price Sent, nurture`

## ✅ 6. Double taps (109s)
- ✓ same button twice within 1s → one reply — `e1 → e3`
- ✓ 'Want DSA code' then 'I run a DSA business' within 2s → only the last one answered — `e1 → e3`

## ✅ 7. Form submissions (50s)
- ✓ form alone → v2 starts once (E1) — `e1`
- ✓ screen_0__0 stored as the contact name — `[TEST] Form Lead`
- ✓ trigger logged as form
- ✓ form + text → v2 starts once — `e1`
- ✓ text + form at the same moment → one run, one welcome — `e1 / 1 run(s)`

## ✅ 8. Free text mid-flow (65s)
- ✓ E8 reply — `e1 → e3 → e8`
- ✓ assigned + agent notified + Question tag
- ✓ a second question doesn't get a second bot reply (once per 24h)

## ✅ 9. Video nudge N1 (timer shortened to 1 min for test numbers) (169s)
- ✓ N1 arrives after the delay — `e1 → e3 → e4a → e7 → n1`
- ✓ N1 cancelled because the lead messaged — `e1 → e3 → e4a → e7 → e8`
- ✓ N1 cancelled because an agent messaged — `e1 → e3 → e4a → e7`
- ✓ N1 'Yes, book demo' → slot picker
- · tick: ["cancelled: lead or agent messaged after it was scheduled","cancelled: lead or agent messaged after it was scheduled","done: sent n1"]

## ✅ 10. Agent active in the last 72h → bot stays out (27s)
- ✓ v2 does NOT start / restart
- ✓ the message lands in the agent's chat, still assigned to them — `Deepa Tyagi`

## ✅ 11. Round-robin across 6 new leads started at the same time (52s)
- ✓ split 3 / 3 across Deepa and Purushottam — `3 / 3`
- ✓ every chat has exactly one pool agent
- · assignments: Purushottam Kumar, Purushottam Kumar, Deepa Tyagi, Purushottam Kumar, Deepa Tyagi, Deepa Tyagi

## ✅ 12. Old flow still runs for numbers not on the test list (31s)
- ✓ no v2 run for a non-test number
- ✓ the old flow started its run (keyword 'hi') exactly as before
- ✓ old flow tried its first step (send fails only because the number is fake)
- · old-flow events: started:start → node_entered:start → node_entered:send_list → message_sent:send_list
