import React from "react";

const PALETTE = [
  ["oklch(0.9 0.03 60)", "oklch(0.42 0.07 60)"],
  ["oklch(0.9 0.03 150)", "oklch(0.4 0.06 150)"],
  ["oklch(0.9 0.03 250)", "oklch(0.42 0.06 250)"],
  ["oklch(0.9 0.03 320)", "oklch(0.42 0.06 320)"],
  ["oklch(0.9 0.035 95)", "oklch(0.42 0.06 95)"],
];
function initialsOf(email) {
  const local = String(email || "").split("@")[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

/** Initials avatar. Tone is a stable hash of the email; agent=true fills with accent.
 *  ring adds the white ring + shadow used in threads and the context panel. */
export function Avatar({ email, initials, size = 32, agent = false, ring = true, style }) {
  let h = 0;
  for (const ch of String(email || initials || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = agent ? ["var(--ht-accent)", "var(--ht-on-accent)"] : PALETTE[h % PALETTE.length];
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", flexShrink: 0, display: "flex",
      alignItems: "center", justifyContent: "center", fontWeight: 600, letterSpacing: "0.02em",
      fontSize: Math.round(size * 0.34), background: bg, color: fg,
      border: ring ? (size >= 48 ? "3px" : "2px") + " solid var(--ht-surface)" : "none",
      boxShadow: ring ? (size >= 48 ? "var(--ht-shadow-md)" : "var(--ht-shadow-sm)") : "none", ...style }}>
      {initials || (agent ? "S" : initialsOf(email))}
    </div>
  );
}
