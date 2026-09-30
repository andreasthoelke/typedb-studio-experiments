export function cleanSourceTitle(title: string | null | undefined): string;
export function snapTitleBase(title: string | null | undefined): string;
export function titledSnapLabel(filename: string, title: string | null | undefined): string | null;
export function splitPlainHeading(line: string | null | undefined): { title: string; comment: string };
