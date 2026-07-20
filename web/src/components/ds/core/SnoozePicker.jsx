import React from "react";
import { MenuItem } from "./MenuItem.jsx";
import { chevron, fmtDay, fmtTime, IconClock, MO, now, WD } from "./primitives-support.jsx";

function laterToday() {
  const d = now();
  d.setHours(17, 0, 0, 0);
  return d;
}
function tomorrow8() {
  const d = now();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}
function thisWeekend() {
  const d = now();
  const day = d.getDay();
  const add = (6 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + add);
  d.setHours(8, 0, 0, 0);
  return d;
}
function nextWeek() {
  const d = now();
  const add = (1 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + add);
  d.setHours(8, 0, 0, 0);
  return d;
}

function MiniCalendar({ value, onChange }) {
  const [view, setView] = React.useState(new Date(value.getFullYear(), value.getMonth(), 1));
  const y = view.getFullYear();
  const m = view.getMonth();
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const ref = now();
  const today = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  const btn = {
    width: 30, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center",
    fontSize: 12.5, fontWeight: 600, border: "none", borderRadius: "var(--ht-radius-sm)",
    cursor: "pointer", background: "none", color: "var(--ht-ink)", fontVariantNumeric: "tabular-nums",
  };
  return (
    <div style={{ width: 246 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <button type="button" title="Previous month" onClick={() => setView(new Date(y, m - 1, 1))}
          style={{ ...btn, width: 28, height: 28, color: "var(--ht-ink-muted)" }}>
          {chevron("left", 15)}
        </button>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{`${MO[m]} ${y}`}</span>
        <button type="button" title="Next month" onClick={() => setView(new Date(y, m + 1, 1))}
          style={{ ...btn, width: 28, height: 28, color: "var(--ht-ink-muted)" }}>
          {chevron("right", 15)}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 1, marginBottom: 2 }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((w, i) => (
          // Weekday initials repeat (two T, two S), and the row is fixed-length
          // and never reordered.
          <span key={`${w}-${i}`} style={{ textAlign: "center", fontSize: 10.5, fontWeight: 700,
            letterSpacing: ".04em", color: "var(--ht-ink-dim)", padding: "2px 0" }}>
            {w}
          </span>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 1 }}>
        {cells.map((d, i) => {
          // Leading blanks before the 1st of the month carry no identity of their
          // own; the index is the only stable key available.
          if (d === null) return <span key={`pad-${i}`} />;
          const date = new Date(y, m, d);
          const sel = date.toDateString() === value.toDateString();
          const isToday = date.toDateString() === today.toDateString();
          const past = date < today;
          return (
            <button key={`d-${d}`} type="button" disabled={past}
              onClick={() => { const nd = new Date(value); nd.setFullYear(y, m, d); onChange(nd); }}
              onMouseEnter={(e) => { if (!sel && !past) e.currentTarget.style.background = "var(--ht-surface-2)"; }}
              onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = "none"; }}
              style={{ ...btn, cursor: past ? "default" : "pointer",
                color: past ? "var(--ht-ink-dim)" : sel ? "var(--ht-on-accent)" : "var(--ht-ink)",
                opacity: past ? 0.5 : 1, background: sel ? "var(--ht-accent)" : "none",
                boxShadow: isToday && !sel ? "inset 0 0 0 1px var(--ht-border)" : "none" }}>
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Choose a wake time: quick presets or a custom calendar + time. The resolved
 *  absolute date/time is shown as confirmation before committing. */
export function SnoozePicker({ onSnooze, inline, initialCustom = false, initialSel }) {
  const presets = [
    { label: "Later today", when: laterToday() },
    { label: "Tomorrow", when: tomorrow8() },
    { label: "This weekend", when: thisWeekend() },
    { label: "Next week", when: nextWeek() },
  ];
  const [custom, setCustom] = React.useState(initialCustom);
  const [sel, setSel] = React.useState(initialSel || nextWeek());
  const [time, setTime] = React.useState("08:00");
  const resolved = React.useMemo(() => {
    const [h, mm] = time.split(":").map(Number);
    const d = new Date(sel);
    d.setHours(h, mm, 0, 0);
    return d;
  }, [sel, time]);

  return (
    <div style={{ width: 278, background: "var(--ht-surface)", border: "1px solid var(--ht-border)",
      borderRadius: "var(--ht-radius-md)", boxShadow: "var(--ht-shadow-md)", overflow: "hidden",
      animation: inline ? "none" : "ht-rise .16s ease-out" }}>
      <div style={{ padding: "9px 12px", borderBottom: "1px solid var(--ht-divider)", fontSize: 10.5,
        fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--ht-ink-dim)" }}>
        Snooze until
      </div>
      {!custom ? (
        <div style={{ padding: 5 }}>
          {presets.map((p) => (
            <MenuItem key={p.label} icon={IconClock(14)}
              shortcut={
                <span style={{ fontFamily: "var(--ht-mono)", fontSize: 11.5, color: "var(--ht-ink-dim)",
                  fontVariantNumeric: "tabular-nums" }}>
                  {p.when.toDateString() === now().toDateString() ? fmtTime(p.when) : `${WD[p.when.getDay()]} ${fmtTime(p.when)}`}
                </span>
              }
              onClick={() => onSnooze?.(p.when)}>
              {p.label}
            </MenuItem>
          ))}
          <div style={{ height: 1, background: "var(--ht-divider)", margin: "5px 6px" }} />
          <MenuItem icon={IconClock(14)} onClick={() => setCustom(true)} shortcut={chevron("right", 13)}>
            Pick date &amp; time
          </MenuItem>
        </div>
      ) : (
        <div style={{ padding: "12px" }}>
          <button type="button" onClick={() => setCustom(false)}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 10, font: "inherit",
              fontSize: 12, fontWeight: 600, color: "var(--ht-accent)", background: "none", border: "none",
              cursor: "pointer", padding: 0 }}>
            {chevron("left", 13)}
            Presets
          </button>
          <MiniCalendar value={sel} onChange={setSel} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
            <span style={{ display: "inline-flex", color: "var(--ht-ink-dim)" }}>{IconClock(15)}</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
              style={{ flex: 1, fontFamily: "var(--ht-mono)", fontSize: 13, color: "var(--ht-ink)",
                background: "var(--ht-bg)", border: "1px solid var(--ht-border)", borderRadius: "var(--ht-radius-sm)",
                padding: "6px 10px", outline: "none" }} />
          </div>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: custom ? "0 12px 12px" : "10px 12px",
        borderTop: custom ? "none" : "1px solid var(--ht-divider)" }}>
        <div style={{ flex: 1, fontSize: 12, color: "var(--ht-ink-muted)", lineHeight: 1.35 }}>
          Wakes <span style={{ fontWeight: 600, color: "var(--ht-ink)" }}>{fmtDay(resolved)}</span>
          <span style={{ fontFamily: "var(--ht-mono)", color: "var(--ht-ink)" }}>{` · ${fmtTime(resolved)}`}</span>
        </div>
        {custom ? (
          <button type="button" onClick={() => onSnooze?.(resolved)}
            style={{ font: "inherit", fontSize: 12.5, fontWeight: 600, color: "var(--ht-on-accent)",
              background: "var(--ht-accent)", border: "none", borderRadius: "var(--ht-radius-sm)",
              padding: "6px 14px", cursor: "pointer" }}>
            Snooze
          </button>
        ) : null}
      </div>
    </div>
  );
}
