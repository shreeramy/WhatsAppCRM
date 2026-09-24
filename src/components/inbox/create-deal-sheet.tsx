"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import type { Pipeline, PipelineStage } from "@/types";
import { Label } from "@/components/ui/label";
import { DealForm } from "@/components/pipelines/deal-form";

interface CreateDealSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  conversationId?: string;
  onCreated: () => void;
}

/**
 * The Pipelines deal form, opened from a chat: the contact and
 * conversation are pre-filled and a pipeline picker sits on top.
 */
export function CreateDealSheet({
  open,
  onOpenChange,
  contactId,
  conversationId,
  onCreated,
}: CreateDealSheetProps) {
  const t = useTranslations("FollowUps");
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelineId, setPipelineId] = useState("");
  const [stages, setStages] = useState<PipelineStage[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from("pipelines")
        .select("*")
        .order("created_at");
      if (cancelled) return;
      const list = (data ?? []) as Pipeline[];
      setPipelines(list);
      setPipelineId((current) =>
        list.some((p) => p.id === current) ? current : list[0]?.id ?? "",
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

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
      open={open}
      onOpenChange={onOpenChange}
      pipelineId={pipelineId}
      stages={stages}
      defaultContactId={contactId}
      conversationId={conversationId}
      onSaved={onCreated}
      headerSlot={
        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("pipeline")}</Label>
          {pipelines.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noPipelines")}</p>
          ) : (
            <select
              value={pipelineId}
              onChange={(e) => setPipelineId(e.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
      }
    />
  );
}
