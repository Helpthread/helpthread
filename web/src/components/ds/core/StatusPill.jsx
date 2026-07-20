import React from "react";

const META = {
  active: { label: "Active", fg: "var(--ht-accent)", bg: "var(--ht-accent-soft)" },
  pending: { label: "Pending", fg: "var(--ht-warn)", bg: "color-mix(in oklab, var(--ht-warn) 12%, transparent)" },
  closed: { label: "Closed", fg: "var(--ht-ink-dim)", bg: "var(--ht-surface-2)" },
  spam: { label: "Spam", fg: "var(--ht-critical)", bg: "var(--ht-critical-soft)" },
  note: { label: "Internal note", fg: "var(--ht-warn)", bg: "color-mix(in oklab, var(--ht-warn) 14%, transparent)" },
};

/** Uppercase status pill; unknown statuses fall back to a neutral pill. */
export function StatusPill({ status, label, style }) {
  const m = META[status] || { label: status, fg: "var(--ht-ink-dim)", bg: "var(--ht-surface-2)" };
  return (
    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
      padding: "3px 10px", borderRadius: 999, whiteSpace: "nowrap", background: m.bg, color: m.fg, ...style }}>
      {label || m.label}
    </span>
  );
}
