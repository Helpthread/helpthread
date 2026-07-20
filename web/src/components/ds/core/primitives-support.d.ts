export declare const RING: string
export declare function chevron(dir?: 'down' | 'up' | 'left' | 'right', sz?: number): JSX.Element
export declare function IconKey(sz?: number): JSX.Element
export declare function IconSearch(sz?: number): JSX.Element
export declare function IconReply(sz?: number): JSX.Element
export declare function IconClock(sz?: number): JSX.Element
export declare function IconPlus(sz?: number): JSX.Element
export declare function IconPencil(sz?: number): JSX.Element
export declare function IconTrash(sz?: number): JSX.Element
export declare function useFocusRing(): [boolean, { onFocus: () => void; onBlur: () => void }]
export declare function now(): Date
export declare const WD: string[]
export declare const MO: string[]
export declare function fmtTime(d: Date): string
export declare function fmtDay(d: Date): string
export declare function fmtDate(d: Date): string
export declare function rel(d: Date): string
