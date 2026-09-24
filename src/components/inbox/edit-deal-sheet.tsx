"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Deal, PipelineStage } from "@/types";
import { DealForm } from "@/components/pipelines/deal-form";

interface EditDealSheetProps {
  deal: Deal | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/** The Pipelines deal editor (incl. follow-ups and call recordings), opened from a chat. */
export function EditDealSheet({ deal, onOpenChange, onSaved }: EditDealSheetProps) {
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const pipelineId = deal?.pipeline_id ?? "";

  useEffect(() => {
    if (!pipelineId) return;
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", pipelineId)
        .order("position");
      if (!cancelled) setStages((data ?? []) as PipelineStage[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [pipelineId]);

  return (
    <DealForm
      open={!!deal}
      onOpenChange={onOpenChange}
      deal={deal}
      pipelineId={pipelineId}
      stages={stages}
      onSaved={onSaved}
    />
  );
}
