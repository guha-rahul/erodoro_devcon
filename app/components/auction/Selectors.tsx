"use client";

/** Segmented expiry selector: 7D / 30D / 60D / 90D. */
export function ExpirySelector({
  value,
  onChange,
  options = [7, 30, 60, 90],
}: {
  value: number;
  onChange: (days: number) => void;
  options?: number[];
}) {
  return (
    <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Expiry">
      {options.map((d) => {
        const selected = value === d;
        return (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(d)}
            className={`rounded-md border px-2 py-2.5 font-mono text-sm tabular-nums transition-colors ${
              selected
                ? "border-accent text-text bg-panel"
                : "border-line-soft text-muted hover:border-line hover:text-text"
            }`}
          >
            {d}D
          </button>
        );
      })}
    </div>
  );
}

/** Quantity slider: 0 to wallet/market balance, with a live readout. */
export function QuantitySlider({
  max,
  value,
  onChange,
  symbol,
  disabled,
  note,
}: {
  max: number;
  value: number;
  onChange: (v: number) => void;
  symbol: string;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[0.9375rem] tabular-nums">
          {value.toFixed(4)} {symbol}
        </span>
        <span className="text-dim font-mono text-[0.78rem] tabular-nums">max {max.toFixed(4)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={max > 0 ? max / 200 : 1}
        value={Math.min(value, max)}
        disabled={disabled || max <= 0}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`Quantity in ${symbol}`}
        className="mt-2 w-full disabled:cursor-not-allowed disabled:opacity-40"
      />
      {note && <p className="text-dim mt-1.5 text-[0.78rem]">{note}</p>}
    </div>
  );
}

/** Upside-gap slider: +% over spot, applied to the cap immediately. */
export function GapSlider({
  spot,
  pct,
  onChange,
  disabled,
}: {
  spot: number | null;
  pct: number;
  onChange: (pct: number) => void;
  disabled?: boolean;
}) {
  const off = disabled || spot === null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[0.9375rem] tabular-nums">+{pct.toFixed(1)}%</span>
        <span className="text-dim font-mono text-[0.78rem] tabular-nums">
          {spot !== null ? `cap $${(spot * (1 + pct / 100)).toFixed(2)}` : "no price yet"}
        </span>
      </div>
      <input
        type="range"
        min={1}
        max={50}
        step={0.5}
        value={pct}
        disabled={off}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Upside gap over current price, percent"
        className="mt-2 w-full disabled:cursor-not-allowed disabled:opacity-40"
      />
      <p className="text-dim mt-1.5 text-[0.78rem]">
        {spot !== null ? "Gains above the cap go to the buyer." : "Choose an asset to price the gap."}
      </p>
    </div>
  );
}
