"use client";

import { useState } from "react";
import { CalendarDays, ChevronDown, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  ALL_TIME,
  PAST_PRESETS,
  isRangeActive,
  type DateRangePreset,
  type DateRangeValue,
} from "@/lib/date-range";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

interface DateRangeFilterProps {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  /** What the dates refer to, e.g. "Created" or "Last message". */
  label: string;
  presets?: DateRangePreset[];
  className?: string;
}

/** Compact "Created: Last 7 days ▾" filter with presets + custom range. */
export function DateRangeFilter({
  value,
  onChange,
  label,
  presets = PAST_PRESETS,
  className,
}: DateRangeFilterProps) {
  const t = useTranslations("DateRange");
  const [open, setOpen] = useState(false);
  const active = isRangeActive(value);

  const summary =
    value.preset === "custom"
      ? active
        ? `${value.from || "…"} → ${value.to || "…"}`
        : t("preset.all")
      : t(`preset.${value.preset}`);

  return (
    <div className={cn("flex items-center", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors",
            active
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border bg-muted text-muted-foreground hover:text-foreground",
            active && "rounded-r-none border-r-0",
          )}
        >
          <CalendarDays className="h-3.5 w-3.5" />
          <span className="whitespace-nowrap">
            {label}: <span className="font-medium">{summary}</span>
          </span>
          <ChevronDown className="h-3 w-3" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1.5">
          <div className="flex flex-col">
            {presets
              .filter((p) => p !== "custom")
              .map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    onChange({ preset: p });
                    setOpen(false);
                  }}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                    value.preset === p ? "font-medium text-primary" : "text-foreground",
                  )}
                >
                  {t(`preset.${p}`)}
                </button>
              ))}
          </div>
          {presets.includes("custom") && (
            <div className="mt-1 space-y-1.5 border-t border-border px-1 pt-2">
              <p className="text-xs font-medium text-muted-foreground">{t("preset.custom")}</p>
              <div className="grid grid-cols-2 gap-1.5">
                <label className="space-y-0.5">
                  <span className="text-[10px] text-muted-foreground">{t("from")}</span>
                  <Input
                    type="date"
                    value={value.preset === "custom" ? value.from ?? "" : ""}
                    onChange={(e) =>
                      onChange({
                        preset: "custom",
                        from: e.target.value,
                        to: value.preset === "custom" ? value.to : undefined,
                      })
                    }
                    className="h-8 bg-muted border-border px-1.5 text-xs text-foreground"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-muted-foreground">{t("to")}</span>
                  <Input
                    type="date"
                    value={value.preset === "custom" ? value.to ?? "" : ""}
                    onChange={(e) =>
                      onChange({
                        preset: "custom",
                        from: value.preset === "custom" ? value.from : undefined,
                        to: e.target.value,
                      })
                    }
                    className="h-8 bg-muted border-border px-1.5 text-xs text-foreground"
                  />
                </label>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {active && (
        <button
          type="button"
          onClick={() => onChange(ALL_TIME)}
          aria-label={t("clear")}
          title={t("clear")}
          className="flex h-8 items-center rounded-r-lg border border-l-0 border-primary/50 bg-primary/10 px-1.5 text-primary hover:bg-primary/20"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
