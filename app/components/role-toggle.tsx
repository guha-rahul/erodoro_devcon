"use client";

import { useRole, type Role } from "@/lib/use-role";

const OPTIONS: { value: Role; label: string; hint: string }[] = [
  { value: "seller", label: "I hold stock", hint: "Sell upside for a premium" },
  { value: "buyer", label: "I want upside", hint: "Buy the upside claim" },
];

/**
 * Which side of the trade the interface should lead with.
 *
 * Not a filter — both sides see the same markets. It decides which action is
 * presented first, because a seller and a buyer arrive wanting opposite things
 * and a screen that serves both equally serves neither.
 */
export function RoleToggle({ onChange }: { onChange?: (r: Role) => void }) {
  const [role, setRole] = useRole();

  return (
    <div className="border-line inline-flex rounded-sm border p-0.5" role="group" aria-label="Your side">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          data-tour={o.value === "seller" ? "role-seller" : "role-buyer"}
          title={o.hint}
          aria-pressed={role === o.value}
          onClick={() => {
            setRole(o.value);
            onChange?.(o.value);
          }}
          className={`rounded-sm px-3 py-1.5 text-[0.8125rem] transition-colors ${
            role === o.value ? "bg-text text-bg font-medium" : "text-muted hover:text-text"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
