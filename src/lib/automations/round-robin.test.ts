import { describe, expect, it } from "vitest";
import { nextRoundRobinAgent, roundRobinPool } from "./round-robin";

const members = [
  { user_id: "owner", account_role: "owner" },
  { user_id: "b-agent", account_role: "agent" },
  { user_id: "a-agent", account_role: "agent" },
  { user_id: "admin", account_role: "admin" },
  { user_id: "viewer", account_role: "viewer" },
];

describe("roundRobinPool", () => {
  it("defaults to members with the Agent role only", () => {
    expect(roundRobinPool(members, undefined)).toEqual(["a-agent", "b-agent"]);
    expect(roundRobinPool(members, [])).toEqual(["a-agent", "b-agent"]);
  });

  it("uses exactly the picked members when some are picked", () => {
    expect(roundRobinPool(members, ["admin", "b-agent"])).toEqual(["admin", "b-agent"]);
  });

  it("ignores picked ids that are no longer members", () => {
    expect(roundRobinPool(members, ["gone", "a-agent"])).toEqual(["a-agent"]);
  });
});

describe("nextRoundRobinAgent", () => {
  const pool = ["a", "b", "c"];

  it("starts with the first agent", () => {
    expect(nextRoundRobinAgent(pool, undefined)).toBe("a");
  });

  it("rotates and wraps around", () => {
    expect(nextRoundRobinAgent(pool, "a")).toBe("b");
    expect(nextRoundRobinAgent(pool, "c")).toBe("a");
  });

  it("continues after an agent who left the pool", () => {
    expect(nextRoundRobinAgent(pool, "bb")).toBe("c");
    expect(nextRoundRobinAgent(pool, "z")).toBe("a");
  });

  it("returns null for an empty pool", () => {
    expect(nextRoundRobinAgent([], "a")).toBeNull();
  });
});
