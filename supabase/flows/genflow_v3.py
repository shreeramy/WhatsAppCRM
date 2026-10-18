"""
Generates supabase/flows/dsa-welcome-v3.json (DSA Welcome v3).

    python supabase/flows/genflow_v3.py

Every price, link, timing and agent setting lives here (config), not in
engine code. Validates WhatsApp limits before writing: <= 3 reply buttons,
labels <= 20 chars, list rows <= 10 and titles <= 24 chars.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- business config -------------------------------------------------------
V2_FLOW_ID = "fcca58b4-6445-492d-ae6a-5cd1d3261192"      # rolled back to / history
HEADER_IMG = "https://kjthxacyqeuuqqwepbgr.supabase.co/storage/v1/object/public/flow-media/welcome/dsa-welcome-header.png"
WEBINAR_WHEN_EN = "Thursday, 22 Oct at 9:00 AM"
WEBINAR_WHEN_HI = "गुरुवार, 22 अक्टूबर, सुबह 9:00 बजे"
VIDEO_EN = "https://youtu.be/1JD25RJFkOU"
VIDEO_HI = "https://youtu.be/-4AXco_mN8c"
REG_FORM = "https://docs.google.com/forms/d/e/1FAIpQLScMCX2Iv9h8VEvRF-sr0gUfVRQ9O3GQNbXQSAyUtN1QJpnHjg/viewform"
PAY_FORM = "https://docs.google.com/forms/d/e/1FAIpQLSeyXBS5MrRFMi2Gs4L-CY83TORYC1Yen1y-YRaxKZIhDr12ng/viewform"
PRICE_SOLO, PRICE_TEAM_M, PRICE_TEAM_Y = 600, 1397, 14400

VIDEO_BLOCK_EN = f"▶️ English: {VIDEO_EN}\n▶️ Hindi: {VIDEO_HI}"
VIDEO_BLOCK_HI = f"▶️ हिंदी: {VIDEO_HI}\n▶️ English: {VIDEO_EN}"

SLOT_PICKER = {
    "mode": "list",
    "times": ["11:00", "12:30", "15:00", "17:30"],
    "slot_minutes": 30,
    "days": 2,
    "max_rows": 6,
    "min_lead_minutes": 60,
    "words": {
        "en": {"days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]},
        "hi": {"days": ["सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि", "रवि"]},
    },
}

nodes = {}
def N(key, typ, **cfg): nodes[key] = {"node_type": typ, "config": cfg}
def A(**k): return k
def btn(node, key, title, nxt): return {"reply_id": f"{node}.{key}", "title": title, "next_node_key": nxt}

def nudge(nodes_map, minutes):
    return A(type="schedule_nudge", nodes=nodes_map, delay_minutes=minutes, capped=True)

N("start", "start", next_node_key="e1")

for L in ("en", "hi"):
    E = L == "en"
    k = (lambda en, hi: en if E else hi)          # node key per language
    t = (lambda en, hi: en if E else hi)          # text per language
    V = VIDEO_BLOCK_EN if E else VIDEO_BLOCK_HI
    welcome, exitn, team, plan_a, plan_b = k("e1","h1"), k("e2","h2"), k("e3","h3"), k("e4a","h4a"), k("e4b","h4b")
    slots, done, call, video, n1, q, fb, fbw = k("e5","h5"), k("e5_done","h5_done"), k("e6","h6"), k("e7","h7"), k("n1","h_n1"), k("e_q","h_q"), k("e8","h8"), k("e8w","h8w")
    other, full, booked, rem = k("e_other","h_other"), k("e5_full","h5_full"), k("booked_en","h_booked"), k("rem_en","rem_hi")
    nw, nt, np_, ns = k("n_welcome","h_nw"), k("n_team","h_nt"), k("n_plan","h_np"), k("n_slot","h_ns")
    rr, e3r, rs, rt = k("ready_route","h_ready_route"), k("e3r","h3r"), k("r_solo","h_r_solo"), k("r_team","h_r_team")
    pays, paym, payy = k("pay_solo","h_pay_solo"), k("pay_team_m","h_pay_team_m"), k("pay_team_y","h_pay_team_y")
    notn, lp, lc, lx, nothx, price = k("e_not","h_not"), k("lost_price","h_lost_price"), k("lost_crm","h_lost_crm"), k("lost_explore","h_lost_explore"), k("no_thanks","h_no_thanks"), k("price_en","price_hi")
    other_lang_welcome = k("h1", "e1")

    NUDGE_W = nudge({"en": "n_welcome", "hi": "h_nw"}, 45)
    NUDGE_T = nudge({"en": "n_team", "hi": "h_nt"}, 60)
    NUDGE_P = nudge({"en": "n_plan", "hi": "h_np"}, 120)
    NUDGE_S = nudge({"en": "n_slot", "hi": "h_ns"}, 30)
    NUDGE_V = nudge({"en": "n1", "hi": "h_n1"}, 120)
    UNLOST = A(type="remove_tag", tag="Lost:*")

    # ---- Welcome (Change 1, 2) ----
    N(welcome, "send_buttons", lang=L, header_image_url=HEADER_IMG,
      text=t("Namaste 🙏\n\nHow many loan files slipped away last month just because a follow-up was missed? 📂\n\nDSA Management keeps every file, follow-up and commission in one place, on your phone. 📱 Your bank DSA code stays 100% yours. This is only software to manage your work.\n\nOne quick question 👇 Are you already working as a DSA / loan agent?",
             "नमस्ते 🙏\n\nपिछले महीने कितनी loan files सिर्फ इसलिए हाथ से निकल गईं क्योंकि follow-up छूट गया? 📂\n\nDSA Management में हर file, follow-up और commission एक जगह, आपके mobile पर। 📱 आपका bank DSA code 100% आपका ही रहेगा। ये सिर्फ आपका काम संभालने का software है।\n\nबस एक सवाल 👇 क्या आप अभी DSA / loan agent का काम करते हैं?"),
      buttons=[btn(f"v2.{welcome}", "dsa", t("Yes, I'm a DSA", "हाँ, मैं DSA हूँ"), team),
               btn(f"v2.{welcome}", "code", t("No, need DSA code", "नहीं, code चाहिए"), exitn),
               btn(f"v2.{welcome}", t("hindi", "english"), t("हिंदी में बताएं", "English please"), other_lang_welcome)],
      title_aliases=t({"I run a DSA business": "e3", "Want DSA code": "e2", "Want to become DSA": "e2"},
                      {"मेरा DSA business है": "h3", "DSA code चाहिए": "h2", "DSA बनना है": "h2", "बस price जानना है": "h3"}),
      actions=[A(type="assign"), NUDGE_W])

    # Price question at the welcome (Change 3) → price line, then team size
    N(price, "send_message", lang=L, reachable_via="settings.text_intents",
      text=t(f"Plans start at ₹{PRICE_SOLO}/month for individuals and ₹{PRICE_TEAM_M:,}/month for teams.",
             f"Plans ₹{PRICE_SOLO}/महीना (individual) और ₹{PRICE_TEAM_M:,}/महीना (team) से शुरू होते हैं।"),
      next_node_key=team)

    # Any other text at the welcome → fallback (+video), then the welcome once more
    FB_TEXT = t(f"Thanks! {{{{agent_intro}}}} will get back to you shortly. Meanwhile, here's a 2-min video that answers most questions 👇\n{V}",
                f"धन्यवाद! {{{{agent_intro}}}} जल्द ही आपसे संपर्क करेंगे। तब तक ये 2-min video देखिए, इसमें ज़्यादातर सवालों के जवाब हैं 👇\n{V}")
    FB_ACTIONS = [A(type="assign"), A(type="add_tag", tag="Question"),
                  A(type="notify_agent", title="❓ Question from {{contact_name}}", body="Reply as soon as you can"),
                  A(type="mark_fallback_replied")]
    N(fbw, "send_message", lang=L, text=FB_TEXT, actions=FB_ACTIONS, next_node_key=welcome, reachable_via="settings.entry_fallback_nodes")
    N(fb, "send_message", lang=L, terminal=True, text=FB_TEXT, actions=FB_ACTIONS, reachable_via="settings.fallback_nodes")

    # Not a fit (unchanged copy)
    N(exitn, "send_buttons", lang=L,
      text=t("Thanks for reaching out! 🙏 We're a software company. We don't provide DSA codes or bank tie-ups. Our CRM is for people who already work as DSAs/loan agents. If you start your DSA work later, we'd love to help you manage it. All the best!",
             "संपर्क करने के लिए धन्यवाद 🙏 हम एक software company हैं। हम DSA code या bank tie-up नहीं देते। हमारा CRM उनके लिए है जो पहले से DSA/loan agent का काम करते हैं। जब आप DSA काम शुरू करें, हम आपकी मदद ज़रूर करेंगे। All the best!"),
      buttons=[btn(f"v2.{exitn}", "dsa", t("Oops, I am a DSA", "मैं DSA हूँ"), team)],
      actions=[A(type="add_tag", tag="Lost: Not-DSA"), A(type="schedule_auto_close", hours=24)])

    # Team size
    TEAM_Q = t("Great! How many people work on loan files in your setup?", "बढ़िया! आपके यहाँ कितने लोग loan files पर काम करते हैं?")
    N(team, "send_buttons", lang=L, text=TEAM_Q,
      buttons=[btn(f"v2.{team}", "solo", t("Just me", "सिर्फ मैं"), plan_a), btn(f"v2.{team}", "team", t("I have a team", "मेरी team है"), plan_b)],
      actions=[A(type="remove_tag", tag="Lost: Not-DSA"), A(type="add_tag", tag="Contacted"), A(type="ensure_deal"), NUDGE_T])

    PLAN_BTNS = lambda n: [btn(f"v2.{n}", "demo", t("Book free demo", "Free demo book करें"), slots),
                           btn(f"v2.{n}", "call", t("Call me", "मुझे call करें"), call),
                           btn(f"v2.{n}", "video", t("Watch video first", "पहले video देखूँगा"), video)]
    N(plan_a, "send_buttons", lang=L,
      text=t(f"Perfect, the Individual Plan fits you:\n\n💰 ₹{PRICE_SOLO}/month\n✅ Track every loan file & its status\n✅ Follow-up reminders, so no file slips away\n✅ Commission tracking\n\nWant to see it live in a free 15-min demo?",
             f"आपके लिए Individual Plan सही रहेगा:\n\n💰 ₹{PRICE_SOLO}/महीना\n✅ हर loan file और उसका status track करें\n✅ Follow-up reminders, कोई file नहीं छूटेगी\n✅ Commission tracking\n\nक्या आप free 15-min demo में इसे live देखना चाहेंगे?"),
      buttons=PLAN_BTNS(plan_a),
      actions=[A(type="set_deal_value", value=PRICE_SOLO, plan="individual"), A(type="add_tag", tag="Price Sent"), NUDGE_P])
    N(plan_b, "send_buttons", lang=L,
      text=t(f"For teams, we have the Team Plan:\n\n💰 ₹{PRICE_TEAM_M:,}/month 🔥 or ₹{PRICE_TEAM_Y:,}/year (save ₹{PRICE_TEAM_M*12-PRICE_TEAM_Y:,}, about 2 months free)\n\n✅ Everything in Individual\n✅ Assign files to team members\n✅ See every member's pipeline & follow-ups\n✅ Team performance reports\n\nWant to see it live in a free 15-min demo?",
             f"Team के लिए हमारा Team Plan:\n\n💰 ₹{PRICE_TEAM_M:,}/महीना 🔥 या ₹{PRICE_TEAM_Y:,}/साल (₹{PRICE_TEAM_M*12-PRICE_TEAM_Y:,} की बचत, लगभग 2 महीने free)\n\n✅ Individual plan के सारे features\n✅ Team members को files assign करें\n✅ हर member की pipeline और follow-ups देखें\n✅ Team performance reports\n\nक्या आप free 15-min demo में इसे live देखना चाहेंगे?"),
      buttons=PLAN_BTNS(plan_b),
      actions=[A(type="set_deal_value", value=PRICE_TEAM_M, plan="team"), A(type="add_tag", tag="Price Sent"), NUDGE_P])

    # Slot list (Change 6)
    N(slots, "send_buttons", lang=L,
      text=t("Pick a time for your free 15-min demo 👇", "अपने free 15-min demo के लिए time चुनें 👇"),
      dynamic_slots={**SLOT_PICKER, "next_node_key": done, "full_node_key": full,
                     "button_label": t("See times", "Time देखें"), "section_title": t("Free slots", "खाली slots"),
                     "extra_rows": [btn(f"v3.{slots}", "call", t("Call me instead", "Call कर लीजिए"), call),
                                    btn(f"v3.{slots}", "other", t("Other time", "कोई और time"), other)]},
      title_aliases=t({"Yes, book demo": "e5"}, {"हाँ, demo चाहिए": "h5"}),
      actions=[UNLOST, NUDGE_S])
    N(full, "send_message", lang=L,
      text=t("That time just filled up 🙈 Please pick another 👇", "ये time अभी भर गया 🙈 कृपया दूसरा चुनें 👇"),
      next_node_key=slots)
    N(done, "send_message", lang=L, terminal=True, dedupe_by="slot",
      text=t(f"Done ✅ Your demo is booked for {{{{slot}}}}. {{{{agent_intro}}}} will send the Google Meet link 10 min before. 🙂\n\nBefore the demo, watch this 2-min video so we can focus on your questions 👇\n{V}",
             f"Done ✅ आपका demo {{{{slot}}}} के लिए book हो गया है। {{{{agent_intro}}}} 10 मिनट पहले Google Meet link भेजेंगे। 🙂\n\nDemo से पहले ये 2-min video देख लीजिए, ताकि demo में आपके सवालों पर बात हो सके 👇\n{V}"),
      actions=[A(type="assign"), A(type="ensure_deal"), A(type="add_tag", tag="Demo Booked"),
               A(type="move_deal_stage", stage="Demo Booked"),
               A(type="create_follow_up", kind="demo", title="Demo – {{slot}} – {{plan_label}}"),
               A(type="notify_agent", title="📅 Demo booked: {{contact_name}}", body="{{slot}}"),
               A(type="schedule_reminder", nodes={"en": "rem_en", "hi": "rem_hi"}, at="10:00", early_cutoff="12:00", early_before_hours=2)])
    N(other, "send_message", lang=L, terminal=True,
      text=t("Sure, tell us a time that suits you and {{agent_intro_lc}} will confirm 🙂",
             "ज़रूर, अपना सुविधाजनक time बताइए, {{agent_intro}} confirm कर देंगे 🙂"),
      actions=[A(type="assign"), A(type="create_follow_up", kind="call", title="Agree a demo time – {{contact_name}}"),
               A(type="notify_agent", title="🕒 Wants another demo time: {{contact_name}}", body="Ask which time suits them")])

    # Already booked (Change 11)
    N(booked, "send_buttons", lang=L, reachable_via="settings.booking_lock",
      text=t("Your demo is already booked for {{slot}} ✅ Need to change anything?", "आपका demo {{slot}} के लिए पहले से book है ✅ कुछ बदलना है?"),
      buttons=[btn(f"v3.{booked}", "change", t("Change time", "Time बदलें"), slots), btn(f"v3.{booked}", "call", t("Call me", "मुझे call करें"), call)])

    # Demo-day reminder (Change 7)
    N(rem, "send_message", lang=L, terminal=True, reachable_via="schedule_reminder",
      text=t(f"Your demo is today at {{{{slot_time}}}} 🙂 {{{{agent_intro}}}} will send the Google Meet link 10 min before. If you haven't yet, watch this 2-min video first 👇\n{V}",
             f"आपका demo आज {{{{slot_time}}}} है 🙂 {{{{agent_intro}}}} 10 मिनट पहले Google Meet link भेजेंगे। अगर अभी तक नहीं देखा, तो पहले ये 2-min video देख लीजिए 👇\n{V}"))

    # Call me (Change 7, 12)
    N(call, "send_message", lang=L, terminal=True,
      text=t(f"Sure! {{{{agent_intro}}}} will call you shortly 📞 Meanwhile, watch this 2-min video so the call is quick and useful 👇\n{V}",
             f"ज़रूर! {{{{agent_intro}}}} जल्द ही आपको call करेंगे 📞 तब तक ये 2-min video देख लीजिए, ताकि call जल्दी और काम की हो 👇\n{V}"),
      text_off_hours=t(f"Sure! {{{{agent_intro}}}} will call you tomorrow 📞 Meanwhile, watch this 2-min video so the call is quick and useful 👇\n{V}",
                       f"ज़रूर! {{{{agent_intro}}}} कल आपको call करेंगे 📞 तब तक ये 2-min video देख लीजिए, ताकि call जल्दी और काम की हो 👇\n{V}"),
      actions=[UNLOST, A(type="assign"), A(type="ensure_deal"), A(type="add_tag", tag="Call Requested"),
               A(type="create_follow_up", kind="call", title="Call back – {{contact_name}}"), A(type="flag_hot"),
               A(type="notify_agent", title="🔥 Call requested: {{contact_name}}", body="Call as soon as you can")])

    # Video (no change) → post-video nudge
    N(video, "send_message", lang=L,
      text=t(f"Here's a 2-min video showing exactly how DSAs use it 👇\n{V}", f"ये 2-min video देखिए कि DSAs इसे कैसे use करते हैं 👇\n{V}"),
      actions=[A(type="add_tag", tag="Nurture"), NUDGE_V])

    # Post-video nudge (Change 9)
    N(n1, "send_buttons", lang=L,
      text=t("Did you get a chance to watch the video? 🙂 What would you like to do next?", "क्या आपने video देखा? 🙂 आगे क्या करना चाहेंगे?"),
      buttons=[btn(f"v3.{n1}", "yes", t("Yes, I want this", "हाँ, लेना है"), rr),
               btn(f"v3.{n1}", "q", t("I have a question", "एक सवाल है"), q),
               btn(f"v3.{n1}", "no", t("Not for me", "मेरे लिए नहीं"), notn)],
      title_aliases=t({"Yes, I want it": "ready_route", "Not watched yet": "e7", "Yes, book demo": "e5"},
                      {"अभी नहीं देखा": "h7", "हाँ, demo चाहिए": "h5"}))

    # 9a. Yes → plan confirm by team size
    N(rr, "start", lang=L, route_by_var={"var": "plan", "map": {"individual": rs, "team": rt}, "default": e3r})
    N(e3r, "send_buttons", lang=L, text=TEAM_Q,
      buttons=[btn(f"v3.{e3r}", "solo", t("Just me", "सिर्फ मैं"), rs), btn(f"v3.{e3r}", "team", t("I have a team", "मेरी team है"), rt)],
      actions=[UNLOST])
    N(rs, "send_buttons", lang=L,
      text=t(f"Great choice! 🎉 Your plan: Individual – ₹{PRICE_SOLO}/month.", f"बढ़िया! 🎉 आपका plan: Individual – ₹{PRICE_SOLO}/महीना।"),
      buttons=[btn(f"v3.{rs}", "ok", t(f"Confirm ₹{PRICE_SOLO}/month", f"Confirm ₹{PRICE_SOLO}/महीना"), pays)],
      actions=[UNLOST])
    N(rt, "send_buttons", lang=L,
      text=t("Great choice! 🎉 Which plan would you like?", "बढ़िया! 🎉 कौन सा plan लेना चाहेंगे?"),
      buttons=[btn(f"v3.{rt}", "m", t(f"₹{PRICE_TEAM_M:,}/month", f"₹{PRICE_TEAM_M:,}/महीना"), paym),
               btn(f"v3.{rt}", "y", t(f"₹{PRICE_TEAM_Y:,}/year", f"₹{PRICE_TEAM_Y:,}/साल"), payy)],
      actions=[UNLOST])
    PAY_TEXT = t(f"Here's how to get started 👇\n1️⃣ Fill the registration form: {REG_FORM}\n2️⃣ Complete payment: {PAY_FORM}\n\n{{{{agent_intro}}}} will call you shortly to help set up your account 📞",
                 f"शुरू करने के लिए 👇\n1️⃣ Registration form भरें: {REG_FORM}\n2️⃣ Payment करें: {PAY_FORM}\n\n{{{{agent_intro}}}} जल्द ही account set up करने में मदद के लिए call करेंगे 📞")
    PAY_TEXT_OFF = PAY_TEXT.replace("shortly", "tomorrow").replace("जल्द ही", "कल")
    def pay_actions(value, plan, label):
        return [A(type="assign"), A(type="ensure_deal"), A(type="set_deal_value", value=value, plan=plan, label=label),
                A(type="add_tag", tag="Ready to Buy"), A(type="move_deal_stage", stage="Payment Pending"),
                A(type="create_follow_up", kind="call", title="Onboarding call – {{plan_label}}"), A(type="flag_hot"),
                A(type="notify_agent", title="🔥 Ready to buy: {{contact_name}}", body="{{plan_label}} — call to onboard")]
    N(pays, "send_message", lang=L, terminal=True, text=PAY_TEXT, text_off_hours=PAY_TEXT_OFF,
      actions=pay_actions(PRICE_SOLO, "individual", f"Individual ₹{PRICE_SOLO}/month"))
    N(paym, "send_message", lang=L, terminal=True, text=PAY_TEXT, text_off_hours=PAY_TEXT_OFF,
      actions=pay_actions(PRICE_TEAM_M, "team", f"Team ₹{PRICE_TEAM_M:,}/month"))
    N(payy, "send_message", lang=L, terminal=True, text=PAY_TEXT, text_off_hours=PAY_TEXT_OFF,
      actions=pay_actions(PRICE_TEAM_Y, "team", f"Team ₹{PRICE_TEAM_Y:,}/year"))

    # 9b. Question
    N(q, "send_message", lang=L, terminal=True,
      text=t("Sure! Type your question here and {{agent_intro_lc}} will get back to you shortly.",
             "ज़रूर! अपना सवाल यहाँ लिखिए, {{agent_intro}} जल्द ही जवाब देंगे।"),
      actions=[A(type="assign"), A(type="add_tag", tag="Question"),
               A(type="notify_agent", title="❓ Question from {{contact_name}}", body="They want to ask something after the video"),
               A(type="flag_hot")])

    # 9c. Not for me → reason list
    N(notn, "send_buttons", lang=L,
      text=t("No problem 🙏 Could you tell us why? It helps us improve.", "कोई बात नहीं 🙏 क्या आप बता सकते हैं क्यों? इससे हमें बेहतर होने में मदद मिलती है।"),
      list={"button_label": t("Choose a reason", "कारण चुनें"),
            "rows": [btn(f"v3.{notn}", "price", t("Too expensive", "बहुत महंगा है"), lp),
                     btn(f"v3.{notn}", "crm", t("Using Excel / other CRM", "Excel/दूसरा CRM है"), lc),
                     btn(f"v3.{notn}", "dsa", t("Not a DSA yet", "अभी DSA नहीं हूँ"), exitn),
                     btn(f"v3.{notn}", "explore", t("Just exploring", "बस देख रहा हूँ"), lx)]})
    N(lp, "send_buttons", lang=L,
      text=t(f"Understood. The yearly plan saves ₹{PRICE_TEAM_M*12-PRICE_TEAM_Y:,} (about 2 months free), and it works out to about ₹20/day. Want a quick call to see if it's worth it for you?",
             f"समझ गए। Yearly plan में ₹{PRICE_TEAM_M*12-PRICE_TEAM_Y:,} की बचत है (लगभग 2 महीने free), यानी करीब ₹20/दिन। क्या एक छोटी call करें, देख लें कि ये आपके काम का है या नहीं?"),
      buttons=[btn(f"v3.{lp}", "call", t("Call me", "मुझे call करें"), call), btn(f"v3.{lp}", "no", t("No thanks", "नहीं, धन्यवाद"), nothx)],
      actions=[A(type="add_tag", tag="Lost: Price")])
    N(lc, "send_buttons", lang=L,
      text=t("Many DSAs start with Excel. The difference is automatic follow-up reminders and commission tracking. Want a 15-min demo to compare?",
             "बहुत से DSAs Excel से शुरू करते हैं। फर्क है automatic follow-up reminders और commission tracking का। Compare करने के लिए 15-min demo देखें?"),
      buttons=[btn(f"v3.{lc}", "demo", t("Book free demo", "Free demo book करें"), slots), btn(f"v3.{lc}", "no", t("No thanks", "नहीं, धन्यवाद"), nothx)],
      actions=[A(type="add_tag", tag="Lost: Already-CRM")])
    N(lx, "send_message", lang=L, terminal=True,
      text=t("No problem! We'll check back in a few weeks. Save this number 🙂", "कोई बात नहीं! कुछ हफ्तों में हम फिर बात करेंगे। ये number save कर लीजिए 🙂"),
      actions=[A(type="add_tag", tag="Lost: No-need"), A(type="stop_automation")])
    N(nothx, "send_message", lang=L, terminal=True,
      text=t("Thanks for your time 🙏 You can message us anytime.", "आपके समय के लिए धन्यवाद 🙏 आप कभी भी message कर सकते हैं।"),
      actions=[A(type="stop_automation"), A(type="close_conversation")])

    # Step nudges (Change 5)
    N(nw, "send_buttons", lang=L,
      text=t("Just one tap 🙂 Are you working as a DSA / loan agent?", "बस एक tap 🙂 क्या आप DSA / loan agent का काम करते हैं?"),
      buttons=[btn(f"v3.{nw}", "dsa", t("Yes, I'm a DSA", "हाँ, मैं DSA हूँ"), team),
               btn(f"v3.{nw}", "call", t("Call me", "मुझे call करें"), call),
               btn(f"v3.{nw}", "lang", t("हिंदी में बताएं", "English please"), other_lang_welcome)])
    N(nt, "send_buttons", lang=L,
      text=t("Solo or with a team? I'll share the right plan for you.", "अकेले काम करते हैं या team के साथ? मैं आपके लिए सही plan बताऊँगा।"),
      buttons=[btn(f"v3.{nt}", "solo", t("Just me", "सिर्फ मैं"), plan_a), btn(f"v3.{nt}", "team", t("I have a team", "मेरी team है"), plan_b)])
    N(np_, "send_buttons", lang=L,
      text=t("Would you like a quick 15-min demo? Pick a time 👇", "क्या आप 15-min का छोटा demo देखना चाहेंगे? Time चुनें 👇"),
      buttons=[btn(f"v3.{np_}", "demo", t("Book free demo", "Free demo book करें"), slots), btn(f"v3.{np_}", "call", t("Call me", "मुझे call करें"), call)])
    N(ns, "send_buttons", lang=L,
      text=t("Any time works for you? We can simply call you 📞", "कोई time सही नहीं लग रहा? हम सीधे call कर लेते हैं 📞"),
      buttons=[btn(f"v3.{ns}", "call", t("Call me", "मुझे call करें"), call), btn(f"v3.{ns}", "slots", t("Pick another time", "दूसरा time चुनें"), slots)])

    # Second nudge per step, 24h after the first (different wording; sent as a template)
    nw2, nt2, np2, ns2, n1b = k("n_welcome2","h_nw2"), k("n_team2","h_nt2"), k("n_plan2","h_np2"), k("n_slot2","h_ns2"), k("n1b","h_n1b")
    R2 = "settings.nudges.followups"
    N(nw2, "send_buttons", lang=L, reachable_via=R2,
      text=t("Still keeping loan files in notebooks or Excel? 📒 DSA Management reminds you of every follow-up, so no file slips away. Are you a DSA / loan agent?",
             "अभी भी loan files diary या Excel में संभाल रहे हैं? 📒 DSA Management हर follow-up याद दिलाता है, कोई file नहीं छूटेगी। क्या आप DSA / loan agent हैं?"),
      buttons=[btn(f"v3.{nw2}", "dsa", t("Yes, I'm a DSA", "हाँ, मैं DSA हूँ"), team),
               btn(f"v3.{nw2}", "call", t("Call me", "मुझे call करें"), call),
               btn(f"v3.{nw2}", "lang", t("हिंदी में बताएं", "English please"), other_lang_welcome)])
    N(nt2, "send_buttons", lang=L, reachable_via=R2,
      text=t(f"One last question 🙂 Do you handle files alone or with a team? Plans start at ₹{PRICE_SOLO}/month.",
             f"बस एक आखिरी सवाल 🙂 files अकेले संभालते हैं या team के साथ? Plans ₹{PRICE_SOLO}/महीना से शुरू।"),
      buttons=[btn(f"v3.{nt2}", "solo", t("Just me", "सिर्फ मैं"), plan_a), btn(f"v3.{nt2}", "team", t("I have a team", "मेरी team है"), plan_b)])
    N(np2, "send_buttons", lang=L, reachable_via=R2,
      text=t("DSAs using DSA Management track every file from login to disbursal on their phone 📱 See it live in a free 15-min demo?",
             "DSA Management से DSAs हर file login से disbursal तक mobile पर track करते हैं 📱 Free 15-min demo में live देखें?"),
      buttons=[btn(f"v3.{np2}", "demo", t("Book free demo", "Free demo book करें"), slots), btn(f"v3.{np2}", "call", t("Call me", "मुझे call करें"), call)])
    N(ns2, "send_buttons", lang=L, reachable_via=R2,
      text=t("Your free demo is still open 🙂 Pick a time that suits you, or we can just give you a quick call.",
             "आपका free demo अभी भी available है 🙂 अपनी सुविधा का time चुनें, या हम आपको एक छोटी call कर लेते हैं।"),
      buttons=[btn(f"v3.{ns2}", "call", t("Call me", "मुझे call करें"), call), btn(f"v3.{ns2}", "slots", t("Pick another time", "दूसरा time चुनें"), slots)])
    N(n1b, "send_buttons", lang=L, reachable_via=R2,
      text=t("Quick check 🙂 Would DSA Management help you close more files? Tell us what you think.",
             "बस पूछना था 🙂 क्या DSA Management से आपकी ज़्यादा files close होंगी? अपनी राय बताइए।"),
      buttons=[btn(f"v3.{n1b}", "yes", t("Yes, I want this", "हाँ, लेना है"), rr),
               btn(f"v3.{n1b}", "q", t("I have a question", "एक सवाल है"), q),
               btn(f"v3.{n1b}", "no", t("Not for me", "मेरे लिए नहीं"), notn)])

    # Webinar invite replies (template quick-reply buttons, matched by title)
    wreg, wno = k("web_reg_en", "web_reg_hi"), k("web_no_en", "web_no_hi")
    N(wreg, "send_message", lang=L, terminal=True, reachable_via="title_aliases",
      title_aliases=t({"Register now": wreg, "Not interested": wno}, {"Register करें": wreg, "Interested नहीं": wno}),
      text=t(f"You're registered ✅ See you on {WEBINAR_WHEN_EN}.\n\nWe'll send the joining link before the session.",
             f"आपका registration हो गया ✅ {WEBINAR_WHEN_HI} मिलते हैं।\n\nJoining link session से पहले भेज देंगे।"),
      actions=[A(type="add_tag", tag="Webinar Registered"), A(type="remove_tag", tag="Webinar: Not interested")])
    N(wno, "send_message", lang=L, terminal=True, reachable_via="title_aliases",
      text=t("No problem 🙏 You can message us anytime if you'd like to see DSA Management.",
             "कोई बात नहीं 🙏 DSA Management देखना हो तो कभी भी message करें।"),
      actions=[A(type="add_tag", tag="Webinar: Not interested"), A(type="remove_tag", tag="Webinar Registered")])

PRICE_WORDS = ["price", "pricing", "cost", "costing", "charges", "charge", "kitna", "kitne", "rate", "fees", "fee", "पैसे", "कीमत", "चार्ज", "कितना"]
settings = {
    "engine": "v2",
    "routing": "test",
    "test_phones": [],
    "dry_run_phones": [],
    "replaces_flow_id": V2_FLOW_ID,
    "history_flow_ids": [V2_FLOW_ID],
    "entry_nodes": {"en": "e1", "hi": "h1"},
    "fallback_nodes": {"en": "e8", "hi": "h8"},
    "entry_fallback_nodes": {"en": "e8w", "hi": "h8w"},
    "working_hours": {"timezone": "Asia/Kolkata", "days": [1, 2, 3, 4, 5, 6], "start": "10:00", "end": "19:00"},
    "agent_pool": [],
    "skip_offline": False,
    "agent_name_pool_only": True,
    "fallback_agent_name": {"en": "Our team", "hi": "हमारी team"},
    "agent_intro": {"en": {"named": "{{name}} from our team", "none": "Our team"},
                    "hi": {"named": "हमारी team से {{name}}", "none": "हमारी team"}},
    "taps_bypass_pause": True,
    "opening_grace_after_form_only": True,
    "entry": {"reengage_after_days": 30, "skip_if_agent_active_hours": 72, "skip_if_run_finished_days": 30, "opening_grace_seconds": 120},
    "language": {"hindi_prefill": ["नमस्ते! क्या मुझे इस बारे में और पता चल सकता है?"], "contact_field": "flow_language"},
    "form": {"field_map": {"screen_0__0": "name"}, "language_field": None},
    "dedupe_window_seconds": 10,
    "tap_debounce_seconds": 1,
    "bot_pause_hours": 72,
    "fallback_reply_cooldown_hours": 24,
    "text_intents": [
        {"keywords": PRICE_WORDS, "at_nodes": ["e1", "h1", "n_welcome", "h_nw"], "target": {"en": "price_en", "hi": "price_hi"}},
        {"keywords": ["team", "5 log", "log hai", "staff", "मेरी team", "टीम"], "at_nodes": ["e3", "h3", "n_team", "h_nt"], "target": {"en": "e4b", "hi": "h4b"}},
        {"keywords": ["akela", "akele", "single", "just me", "only me", "main hi", "सिर्फ मैं", "अकेला"], "at_nodes": ["e3", "h3", "n_team", "h_nt"], "target": {"en": "e4a", "hi": "h4a"}},
        {"keywords": PRICE_WORDS, "target": {"en": "e3", "hi": "h3"},
         "by_var": {"var": "plan", "map": {"individual": {"en": "e4a", "hi": "h4a"}, "team": {"en": "e4b", "hi": "h4b"}}}},
    ],
    "deal": {"pipeline": "Sales Pipeline", "new_stage": "New Lead", "currency": "INR"},
    "slot_capacity": 2,
    "booking_lock": {"nodes": ["e1", "h1", "e2", "h2", "e3", "h3", "e4a", "e4b", "h4a", "h4b"], "redirect": {"en": "booked_en", "hi": "h_booked"}},
    "nudges": {
        "max_per_lead": 10,
        "quiet_start": "21:00", "quiet_end": "10:00", "shift_to": "10:30",
        "final_after_hours": 24,
        "final_actions": [
            {"type": "create_follow_up", "kind": "call", "title": "No reply after 2 nudges – call {{contact_name}}"},
            {"type": "notify_agent", "title": "📵 No reply after 2 nudges: {{contact_name}}", "body": "Please call"},
            {"type": "stop_automation"},
        ],
        "templates": {
            "n_welcome": {"name": "dsa_nudge_welcome", "language": "en"}, "h_nw": {"name": "dsa_nudge_welcome_hi", "language": "hi"},
            "n_team": {"name": "dsa_nudge_team", "language": "en"}, "h_nt": {"name": "dsa_nudge_team_hi", "language": "hi"},
            "n_plan": {"name": "dsa_nudge_plan", "language": "en"}, "h_np": {"name": "dsa_nudge_plan_hi", "language": "hi"},
            "n_slot": {"name": "dsa_nudge_slot", "language": "en"}, "h_ns": {"name": "dsa_nudge_slot_hi", "language": "hi"},
            "n1": {"name": "dsa_nudge_video", "language": "en"}, "h_n1": {"name": "dsa_nudge_video_hi", "language": "hi"},
            "n_welcome2": {"name": "dsa_nudge2_welcome", "language": "en"}, "h_nw2": {"name": "dsa_nudge2_welcome_hi", "language": "hi"},
            "n_team2": {"name": "dsa_nudge2_team", "language": "en"}, "h_nt2": {"name": "dsa_nudge2_team_hi", "language": "hi"},
            "n_plan2": {"name": "dsa_nudge2_plan", "language": "en"}, "h_np2": {"name": "dsa_nudge2_plan_hi", "language": "hi"},
            "n_slot2": {"name": "dsa_nudge2_slot", "language": "en"}, "h_ns2": {"name": "dsa_nudge2_slot_hi", "language": "hi"},
            "n1b": {"name": "dsa_nudge2_video", "language": "en"}, "h_n1b": {"name": "dsa_nudge2_video_hi", "language": "hi"},
        },
        "followups": {"n_welcome": "n_welcome2", "h_nw": "h_nw2", "n_team": "n_team2", "h_nt": "h_nt2",
                      "n_plan": "n_plan2", "h_np": "h_np2", "n_slot": "n_slot2", "h_ns": "h_ns2", "n1": "n1b", "h_n1": "h_n1b"},
        "followup_after_hours": 24,
    },
    "reminder_templates": {"en": {"name": "dsa_demo_reminder", "language": "en"}, "hi": {"name": "dsa_demo_reminder_hi", "language": "hi"}},
    "nudge_template": None,
    "test_overrides": {"working_hours_mode": "auto"},
}

flow = {"name": "DSA Welcome v3",
        "description": "v3: image welcome, assign on first message, step nudges (max 2), 30-min slot list with capacity, post-video buy path, lost reasons.",
        "settings": settings,
        "nodes": [{"node_key": k, **v} for k, v in nodes.items()]}

# ---- validation ------------------------------------------------------------
keys = set(nodes)
def opts(c):
    return (c.get("buttons") or []) + ((c.get("list") or {}).get("rows") or []) + ((c.get("dynamic_slots") or {}).get("extra_rows") or [])
ids = set()
for k, v in nodes.items():
    c = v["config"]
    assert len(c.get("buttons", [])) <= 3, k
    for b in c.get("buttons", []):
        assert len(b["title"]) <= 20, (k, b["title"], len(b["title"]))
    rows = ((c.get("list") or {}).get("rows") or [])
    assert len(rows) <= 10, k
    for r in rows + ((c.get("dynamic_slots") or {}).get("extra_rows") or []):
        assert len(r["title"]) <= 24, (k, r["title"])
    for o in opts(c):
        assert o["next_node_key"] in keys, (k, o)
        assert o["reply_id"] not in ids, ("duplicate reply id", o["reply_id"])
        ids.add(o["reply_id"])
    for tgt in (c.get("title_aliases") or {}).values(): assert tgt in keys, (k, tgt)
    if c.get("next_node_key"): assert c["next_node_key"] in keys, k
    ds = c.get("dynamic_slots")
    if ds: assert ds["next_node_key"] in keys and ds["full_node_key"] in keys, k
    rb = c.get("route_by_var")
    if rb: assert all(x in keys for x in list(rb["map"].values()) + [rb["default"]]), k
    for a in c.get("actions", []):
        if a["type"] in ("schedule_nudge", "schedule_reminder"):
            assert all(n in keys for n in a["nodes"].values()), (k, a)
    for txt in (c.get("text"), c.get("text_off_hours")):
        if txt:
            low = txt.lower()
            for banned in ("30 minutes", "30 मिनट के अंदर", "10 am–7 pm", "10–11 am", "10–11 बजे"):
                assert banned not in low, (k, banned)
for tpl_node in settings["nudges"]["templates"]: assert tpl_node in keys, tpl_node
for a_, b_ in settings["nudges"]["followups"].items(): assert a_ in keys and b_ in keys and b_ in settings["nudges"]["templates"], (a_, b_)
for n in list(settings["entry_nodes"].values()) + list(settings["fallback_nodes"].values()) + list(settings["entry_fallback_nodes"].values()) + list(settings["booking_lock"]["redirect"].values()) + settings["booking_lock"]["nodes"]:
    assert n in keys, n
json.dump(flow, open(os.path.join(HERE, "dsa-welcome-v3.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("nodes", len(nodes))
