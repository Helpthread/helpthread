/** Keyboard focus ring, matching the shipped token set. */
export declare const RING: string;

/** Directional chevron glyph. */
export declare function chevron(dir?: "down" | "up" | "left" | "right", sz?: number): JSX.Element;

export declare function IconKey(sz: number): JSX.Element;
export declare function IconSearch(sz?: number): JSX.Element;
export declare function IconReply(sz: number): JSX.Element;
export declare function IconClock(sz: number): JSX.Element;
export declare function IconPlus(sz?: number): JSX.Element;
export declare function IconPencil(sz?: number): JSX.Element;
export declare function IconTrash(sz?: number): JSX.Element;

/** Focusable helper: manages a :focus-visible-like ring via keyboard focus. */
export declare function useFocusRing(): [boolean, { onFocus: () => void; onBlur: () => void }];

/** The live clock. The design source froze this reference; the app always uses real time. */
export declare function now(): Date;

export declare const WD: string[];
export declare const MO: string[];

export declare function fmtTime(d: Date): string;
export declare function fmtDay(d: Date): string;
export declare function fmtDate(d: Date): string;
/** Relative time string ("just now", "5m ago", …), falling back to fmtDate for older dates. */
export declare function rel(d: Date): string;
