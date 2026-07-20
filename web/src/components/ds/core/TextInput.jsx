import React from "react";

/** Small text input (tag popover style). */
export function TextInput({ value, onChange, onKeyDown, placeholder, id, style }) {
  return (
    <input id={id} type="text" value={value} onChange={onChange} onKeyDown={onKeyDown} placeholder={placeholder}
      style={{ width: "100%", boxSizing: "border-box", fontFamily: "var(--ht-sans)", fontSize: 12.5,
        color: "var(--ht-ink)", background: "var(--ht-bg)", border: "1px solid var(--ht-divider)",
        borderRadius: "var(--ht-radius-sm)", padding: "6px 10px", outline: "none", ...style }} />
  );
}
