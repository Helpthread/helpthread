import React from "react";

/** Lowercase tag chip with optional remove. */
export function TagChip({ label, onRemove }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600,
      color: "var(--ht-ink-muted)", background: "var(--ht-surface-2)", borderRadius: 999,
      padding: onRemove ? "3px 6px 3px 10px" : "3px 10px" }}>
      {label}
      {onRemove && (
        <button type="button" title="Remove tag" onClick={onRemove}
          style={{ width: 15, height: 15, display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--ht-ink-dim)", background: "none", border: "none", borderRadius: "50%", cursor: "pointer", padding: 0 }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      )}
    </span>
  );
}
