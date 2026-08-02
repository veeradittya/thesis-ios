"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "@/lib/utils";

// Compact shadcn-style chart wrapper over Recharts: a ChartContainer that provides a ResponsiveContainer,
// dark-theme axis/grid styling, and per-series color CSS vars (`--color-<key>`), plus a styled tooltip.
export type ChartConfig = {
  [k: string]: {
    label?: React.ReactNode;
    color?: string;
    icon?: React.ComponentType;
  };
};

type ChartContextProps = { config: ChartConfig };
const ChartContext = React.createContext<ChartContextProps | null>(null);
function useChart() {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error("useChart must be used within a <ChartContainer />");
  return ctx;
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colors = Object.entries(config).filter(([, c]) => c.color);
  if (!colors.length) return null;
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `[data-chart="${id}"]{${colors.map(([k, c]) => `--color-${k}:${c.color};`).join("")}}`,
      }}
    />
  );
}

export function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${(id || uniqueId).replace(/:/g, "")}`;
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={cn(
          "flex justify-center text-[11px]",
          "[&_.recharts-cartesian-axis-tick_text]:fill-white/45 [&_.recharts-cartesian-axis-line]:stroke-white/15",
          "[&_.recharts-cartesian-grid_line]:stroke-white/[0.07] [&_.recharts-surface]:outline-none",
          "[&_.recharts-sector]:outline-none [&_.recharts-layer]:outline-none",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

// Row shape Recharts hands the tooltip; kept loose since it varies by chart type.
export interface TooltipItem {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
  payload?: Record<string, unknown>;
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  labelKey,
  hideIndicator,
  className,
  formatValue,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: React.ReactNode;
  labelKey?: string;
  hideIndicator?: boolean;
  className?: string;
  formatValue?: (v: number | string | undefined, item: TooltipItem) => React.ReactNode;
}) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;
  const heading = labelKey ? (payload[0]?.payload?.[labelKey] as React.ReactNode) : label;
  return (
    <div
      className={cn(
        "min-w-[9rem] rounded-xl border border-white/10 bg-black/90 px-3 py-2 text-[12px] shadow-[0_16px_40px_-12px_rgba(0,0,0,0.8)] backdrop-blur-md",
        className,
      )}
    >
      {heading != null && heading !== "" && <div className="mb-1.5 font-medium text-white">{heading}</div>}
      <div className="flex flex-col gap-1">
        {payload.map((item, i) => {
          const key = String(item.dataKey ?? item.name ?? i);
          const c = config[key];
          const color = item.color || c?.color;
          return (
            <div key={i} className="flex items-center gap-2 text-white/60">
              {!hideIndicator && color && <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: color }} />}
              <span>{c?.label ?? item.name}</span>
              <span className="ml-auto font-medium tabular-nums text-white">
                {formatValue ? formatValue(item.value, item) : item.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
