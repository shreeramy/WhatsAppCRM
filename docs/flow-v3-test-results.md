# DSA Welcome v3 — end-to-end test results

Run 2026-10-18T11:29:55.668Z against https://wacrm-jet-two.vercel.app. Simulated Meta-signed webhooks for test numbers; bot replies are written to the inbox but not sent to Meta. Timers shortened for test numbers (nudges, final hand-over and demo reminder: 1 minute). Removed 29 test contacts afterwards.

## ✅ 1. English welcome: image header + 3 buttons; Yes, I'm a DSA → team size (7s)
- ✓ header image on the welcome — `https://kjthxacyqeuuqqwepbgr.supabase.co/storage/v1/object/public/flow-media/welcome/dsa-welcome-header.png`
- ✓ 3 buttons — `Yes, I'm a DSA · No, need DSA code · हिंदी में बताएं`
- ✓ new copy
- ✓ → team size — `e1 → e3`

## ✅ 2. Hindi first message → H1 (new copy); English please → E1 (5s)
- ✓ H1 directly with the new Hindi copy — `नमस्ते 🙏

पिछले महीने कितनी loan files `
- ✓ Hindi buttons
- ✓ English please → E1 — `h1 → e1`

## ✅ 3. Assignment on the first message; 6 new leads alternate; Rahul never (10s)
- ✓ assigned right after the first message
- ✓ only pool agents (never Rahul)
- ✓ 3 / 3 alternation — `3/3`
- · assigned: Purushottam Kumar, Deepa Tyagi, Purushottam Kumar, Deepa Tyagi, Purushottam Kumar, Deepa Tyagi

## ✅ 4. Text at the welcome: 'Costing ?' → price + team size; 'ye kya hai' → fallback + video + agent notified (14s)
- ✓ price line then team-size question — `e1 → price_en → e3`
- ✓ price line text
- ✓ fallback (with video) then the welcome again — `e1 → e8w → e1`
- ✓ fallback has the video
- ✓ agent notified

## ✅ 5. Agent messaged, then the lead taps an old button → bot still answers (5s)
- ✓ tap answered during the bot pause — `e1 → e3`

## ✅ 6. Nudges: welcome nudge, 2nd at the next step, no 3rd → agent follow-up (timers shortened) (217s)
- ✓ 1st nudge at the welcome — `e1 → n_welcome`
- ✓ 2nd nudge at the team-size step — `e1 → n_welcome → e3 → n_team`
- ✓ agent follow-up 'No reply after 2 nudges' — `No reply after 2 nudges – call [TEST] v3 12`
- ✓ no 3rd nudge scheduled — `n_welcome:done, n_team:done`

## ✅ 7. Nudge cancelled when the lead types or an agent messages (quiet hours: unit-tested) (82s)
- ✓ lead typed → nudge not sent — `cancelled,cancelled`
- ✓ agent messaged → nudge not sent — `cancelled,cancelled`

## ✅ 8. Slot list: only free 30-min slots, capacity 2, Call me instead + Other time (51s)
- ✓ ≤ 6 slot rows of 30 min + 2 fixed rows
- ✓ 3rd booking refused (slot full → list again) — `e1 → e3 → e4a → e5 → e5_full → e5`
- ✓ full slot no longer offered
- ✓ Other time → reply + follow-up + agent notified
- ✓ Call me instead → Call me — `e1 → e3 → e4a → e5 → e5_full → e5 → e6`
- · list rows: Mon 11:00–11:30 AM · Mon 12:30–1:00 PM · Mon 3:00–3:30 PM · Mon 5:30–6:00 PM · Tue 11:00–11:30 AM · Tue 12:30–1:00 PM · Call me instead · Other time

## ✅ 9. Two slot picks within 10s → the last one is booked (25s)
- ✓ the last pick is the booking — `2026-10-19T12:00:00+00:00`
- ✓ confirmation shows that slot — `Done ✅ Your demo is booked for Mon 19 Oct, 5:30–6:00 PM. Dee`
- ✓ one meeting follow-up, 15 min before that slot — `2026-10-19T11:45:00+00:00`

## ✅ 10. Call me (in hours / off hours) and the fallback include the video; no promised times anywhere (101s)
- ✓ [open] Call me has the video
- ✓ [open] wording
- ✓ [closed] Call me has the video
- ✓ [closed] wording
- ✓ no promised times in 72 bot messages
- · [open] Sure! Purushottam from our team will call you shortly 📞 Meanwhile, watch this 2-min video so the call is quick and useful 👇
- · [closed] Sure! Deepa from our team will call you tomorrow 📞 Meanwhile, watch this 2-min video so the call is quick and useful 👇

## ✅ 11. Demo-day reminder with the video (timer shortened) (85s)
- ✓ reminder scheduled
- ✓ reminder sent with slot time + video — `Your demo is today at 12:30–1:00 PM 🙂 Deepa from our team will send t`

## ✅ 12. Post-video: Yes, I want this → plan → registration + payment; tag, stage, follow-up, alert (89s)
- ✓ solo → 'Your plan: Individual – ₹600/month' — `e1 → e3 → e4a → e7 → n1 → r_solo`
- ✓ registration + payment links
- ✓ tag Ready to Buy
- ✓ deal ₹600, stage Payment Pending — `600 / Payment Pending`
- ✓ onboarding follow-up
- ✓ urgent alert

## ✅ 13. Not for me → reasons + tags; a later Call me removes the Lost: tag (50s)
- ✓ Too expensive → lost_price, tag Lost: Price — `e1 → e_not → lost_price / Lost: Price`
- ✓ Using Excel / other CRM → lost_crm, tag Lost: Already-CRM — `e1 → e_not → lost_crm / Lost: Already-CRM`
- ✓ Not a DSA yet → e2, tag Lost: Not-DSA — `e1 → e_not → e2 / Lost: Not-DSA`
- ✓ Just exploring → lost_explore, tag Lost: No-need — `e1 → e_not → lost_explore / Lost: No-need`
- ✓ later Call me removes Lost: Price — `Call Requested`

## ✅ 14. No, need DSA code → Oops, I am a DSA removes Lost: Not-DSA (13s)
- ✓ Lost: Not-DSA added
- ✓ removed after Oops — `Contacted`

## ✅ 15. Demo booked + old welcome button → 'already booked'; Change time moves booking and follow-up (36s)
- ✓ old welcome button → 'already booked' — `e1 → e3 → e4a → e5 → e5_done → booked_en`
- ✓ booking moved to the new slot
- ✓ only the new demo follow-up remains — `2026-10-19T06:45:00+00:00`
