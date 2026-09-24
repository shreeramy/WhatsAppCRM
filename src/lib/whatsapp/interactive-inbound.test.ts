import { describe, expect, it } from "vitest";
import { formatInboundInteractive, humanizeFieldKey } from "./interactive-inbound";

describe("humanizeFieldKey", () => {
  it("strips Flow screen prefixes and index suffixes", () => {
    expect(humanizeFieldKey("screen_0_Full_Name_0")).toBe("Full Name");
    expect(humanizeFieldKey("email_address")).toBe("Email address");
    expect(humanizeFieldKey("companyName")).toBe("Company Name");
  });
});

describe("formatInboundInteractive", () => {
  it("lists a submitted Flow form's answers, dropping flow_token", () => {
    const text = formatInboundInteractive({
      type: "nfm_reply",
      nfm_reply: {
        name: "flow",
        body: "Sent",
        response_json: JSON.stringify({
          flow_token: "abc",
          screen_0_Full_Name_0: "Rahul Patel",
          screen_0_Budget_1: "1_50k_to_1L",
          screen_0_Services_2: ["0_CRM", "2_WhatsApp_bot"],
        }),
      },
    });
    expect(text).toBe(
      "📝 Form submitted\n• Full Name: Rahul Patel\n• Budget: 50k to 1L\n• Services: CRM, WhatsApp bot",
    );
  });

  it("labels a shared address", () => {
    const text = formatInboundInteractive({
      type: "nfm_reply",
      nfm_reply: {
        name: "address_message",
        response_json: JSON.stringify({ values: { city: "Indore" } }),
      },
    });
    expect(text.startsWith("📍 Address shared\n• Values:")).toBe(true);
    expect(text).toContain("Indore");
  });

  it("keeps non-JSON form bodies as-is", () => {
    expect(
      formatInboundInteractive({ type: "nfm_reply", nfm_reply: { response_json: "oops" } }),
    ).toBe("📝 Form submitted\noops");
  });

  it("describes call permission answers", () => {
    expect(
      formatInboundInteractive({
        type: "call_permission_reply",
        call_permission_reply: { response: "accept", is_permanent: true },
      }),
    ).toBe("📞 Call permission granted (permanently)");
    expect(
      formatInboundInteractive({
        type: "call_permission_reply",
        call_permission_reply: { response: "reject" },
      }),
    ).toBe("📞 Call permission declined");
  });

  it("keeps the type and payload of anything unrecognised", () => {
    expect(formatInboundInteractive({ type: "payment_method", payment_method: { id: "x" } })).toBe(
      '[Interactive reply: payment_method]\n{"payment_method":{"id":"x"}}',
    );
  });
});
