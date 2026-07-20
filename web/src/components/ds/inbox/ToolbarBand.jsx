import React from "react";

/** The 48px band that caps the work sheet. tone "accent" (8% tint) over the
 *  thread/list; tone "panel" (neutral gray) continues over the context panel. */
export function ToolbarBand({ tone = "accent", children, style }) {
  return (
    <div style={{ minHeight: 48, boxSizing: "border-box", display: "flex", alignItems: "center",
      gap: 6, flexWrap: "wrap", padding: "6px 14px",
      background: tone === "panel"
        ? "color-mix(in oklab, var(--ht-ink) 4%, var(--ht-bg))"
        : "color-mix(in oklab, var(--ht-accent) 8%, var(--ht-surface))",
      borderBottom: "1px solid var(--ht-divider)", ...style }}>
      {children}
    </div>
  );
}
