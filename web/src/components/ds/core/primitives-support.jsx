import React from "react";

/**
 * Shared helpers for the four primitives added 2026-07-19 (HT-93):
 * SplitButton · CommandMenu · SnoozePicker · CredentialRow.
 *
 * Icon glyphs, the focus-ring token, and the date formatters live here rather
 * than being duplicated per component — the design source carried one copy of
 * each in a single file, and splitting that file per component must not turn
 * one definition into four.
 */

/** Keyboard focus ring, matching the shipped token set. */
export const RING = "0 0 0 3px var(--ht-accent-soft)";

const svg = (d, sz = 15, extra) => (
  <svg width={sz} height={sz} viewBox="0 0 24 24" fill="currentColor" {...extra}>
    <path d={d} />
  </svg>
);

export const chevron = (dir = "down", sz = 14) => {
  const pts = {
    down: "6 9 12 15 18 9", up: "18 15 12 9 6 15", left: "15 18 9 12 15 6", right: "9 18 15 12 9 6",
  }[dir];
  return (
    <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}
      strokeLinecap="round" strokeLinejoin="round">
      <polyline points={pts} />
    </svg>
  );
};

export const IconKey = (sz) =>
  svg("M7 14a5 5 0 1 1 4.9-6H21v3h-2v3h-3v-3h-1.1A5 5 0 0 1 7 14zm-1-5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z", sz);

export const IconSearch = (sz = 15) => (
  <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
    strokeLinecap="round">
    <circle cx={11} cy={11} r={7} />
    <line x1={21} y1={21} x2={16.5} y2={16.5} />
  </svg>
);

export const IconReply = (sz) => svg("M10 9V5l-7 7 7 7v-4c5 0 8 1.5 10 5 .5-6-2.5-11-10-11z", sz);

export const IconClock = (sz) =>
  svg("M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.6V7h-2v6l4.8 2.9 1-1.7-3.8-2.6z", sz);

export const IconPlus = (sz = 14) => (
  <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}
    strokeLinecap="round">
    <line x1={12} y1={5} x2={12} y2={19} />
    <line x1={5} y1={12} x2={19} y2={12} />
  </svg>
);

export const IconPencil = (sz = 15) =>
  svg(
    "M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.58z",
    sz,
  );

export const IconTrash = (sz = 15) => svg("M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z", sz);

/** Focusable helper: manages :focus-visible-like ring via keyboard focus. */
export function useFocusRing() {
  const [f, setF] = React.useState(false);
  return [f, { onFocus: () => setF(true), onBlur: () => setF(false) }];
}

/**
 * The design source froze a reference clock (`NOW = 2026-07-19 14:30`) so its
 * specimen times wouldn't drift between renders. The app needs real time —
 * a frozen clock would make SnoozePicker compute "tomorrow" from a past date.
 * This is the one intentional behavioral difference from the design source.
 */
export const now = () => new Date();

export const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const fmtTime = (d) => {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
};

export const fmtDay = (d) => `${WD[d.getDay()]}, ${MO[d.getMonth()]} ${d.getDate()}`;

export const fmtDate = (d) => `${MO[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

export const rel = (d) => {
  const s = (now() - d) / 1000;
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const dd = h / 24;
  if (dd < 2) return "yesterday";
  if (dd < 7) return `${Math.round(dd)}d ago`;
  return fmtDate(d);
};
