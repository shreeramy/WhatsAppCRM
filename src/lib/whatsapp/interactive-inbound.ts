// Readable text for inbound `interactive` messages other than button /
// list taps (those are handled inline in the webhook). Without this they
// all landed in the inbox as a bare "[Interactive reply]".
//
// Meta types covered:
//   - nfm_reply  → a WhatsApp Flow / form the customer submitted
//                  (`name: 'flow'`) or an address they shared
//                  (`name: 'address_message'`). Answers are a JSON
//                  string in `response_json`.
//   - call_permission_reply → customer allowed / declined calls.
// Anything else keeps its type and a compact dump of the payload so
// no information is silently lost.

export interface InboundInteractive {
  type?: string;
  nfm_reply?: { name?: string; body?: string; response_json?: string };
  call_permission_reply?: {
    response?: string;
    is_permanent?: boolean;
    expiration_timestamp?: number | string;
  };
  [key: string]: unknown;
}

const MAX_TEXT = 3000;

/** "screen_0_Full_Name_0" → "Full Name"; "email_address" → "Email address". */
export function humanizeFieldKey(key: string): string {
  const cleaned = key
    .replace(/^screen_\d+_/i, "")
    .replace(/_\d+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  if (!cleaned) return key;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Flow dropdown / radio values arrive as "0_Option_label" ids. */
function humanizeValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(humanizeValue).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value).trim();
  const option = /^\d+_(.+)$/.exec(s);
  return option ? option[1].replace(/_/g, " ") : s;
}

function formatAnswers(json: string | undefined): string[] {
  if (!json) return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [json];
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return [String(json)];
  return Object.entries(data as Record<string, unknown>)
    // flow_token is Meta's session id, not something the customer typed.
    .filter(([k]) => k !== "flow_token")
    .map(([k, v]) => [humanizeFieldKey(k), humanizeValue(v)] as const)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `• ${k}: ${v}`);
}

function clamp(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

export function formatInboundInteractive(interactive: InboundInteractive | undefined): string {
  if (!interactive) return "[Interactive reply]";

  if (interactive.nfm_reply) {
    const { name, response_json } = interactive.nfm_reply;
    const heading =
      name === "address_message" ? "📍 Address shared" : "📝 Form submitted";
    const lines = formatAnswers(response_json);
    return clamp(lines.length ? `${heading}\n${lines.join("\n")}` : heading);
  }

  if (interactive.call_permission_reply) {
    const r = interactive.call_permission_reply;
    const accepted = r.response === "accept";
    const scope = accepted ? (r.is_permanent ? " (permanently)" : " (temporarily)") : "";
    return `📞 Call permission ${accepted ? "granted" : "declined"}${scope}`;
  }

  const type = interactive.type ?? "unknown";
  const { type: _t, ...rest } = interactive;
  void _t;
  const detail = Object.keys(rest).length ? `\n${JSON.stringify(rest)}` : "";
  return clamp(`[Interactive reply: ${type}]${detail}`);
}
