import React from "react";

/** 32px square icon action. tone "header" renders on the accent top bar. */
export function IconButton({ title, onClick, active = false, tone = "default", size = 32, style, children }) {
  const header = tone === "header";
  const fg = header ? "color-mix(in oklab, var(--ht-header-fg) 85%, transparent)" : "var(--ht-accent)";
  const hoverBg = header ? "color-mix(in oklab, var(--ht-header-fg) 16%, transparent)" : "var(--ht-accent-soft)";
  return (
    <button type="button" title={title} onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size,
        flexShrink: 0, color: fg, background: active ? hoverBg : "none", border: "none",
        borderRadius: "var(--ht-radius-sm)", cursor: "pointer", ...style }}
      onMouseEnter={(e) => { e.currentTarget.style.background = hoverBg; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = active ? hoverBg : "transparent"; }}>
      {children}
    </button>
  );
}
