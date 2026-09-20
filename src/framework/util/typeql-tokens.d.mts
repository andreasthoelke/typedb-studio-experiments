export interface Token { text: string; from: number; depth: number; kind: "word" | "variable" | "symbol" | "literal"; }
export function tokens(text: string, tolerant?: boolean, literals?: boolean): Token[];
