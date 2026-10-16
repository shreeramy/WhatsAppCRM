import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateFlowForActivation } from "../validate";
import { deriveCanvasEdges, outgoingSlots } from "../edges";
import type { BuilderNode } from "@/components/flows/shared";

const def = JSON.parse(readFileSync("supabase/flows/dsa-welcome-v2.json", "utf8")) as {
  name: string;
  nodes: Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>;
};

describe("DSA Welcome v2 in the flow builder", () => {
  it("validates clean (no false errors for terminal steps, slot pickers or nudges)", () => {
    const issues = validateFlowForActivation(
      { name: def.name, trigger_type: "manual", trigger_config: {}, entry_node_id: "start" },
      def.nodes,
    );
    expect(issues).toEqual([]);
  });

  it("draws the slot-picked and nudge arrows on the canvas", () => {
    const nodes = def.nodes.map((n) => ({ ...n, position_x: 0, position_y: 0 })) as unknown as BuilderNode[];
    const edges = deriveCanvasEdges(nodes);
    expect(edges).toContainEqual(expect.objectContaining({ source: "e5", target: "e5_done", sourceHandle: "slot" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "e7", target: "n1", sourceHandle: "nudge" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "h7", target: "h_n1", sourceHandle: "nudge" }));
    // Every edge's handle exists on its source card.
    for (const e of edges) {
      const src = nodes.find((n) => n.node_key === e.source)!;
      expect(outgoingSlots(src).map((s) => s.id)).toContain(e.sourceHandle);
    }
  });
});
