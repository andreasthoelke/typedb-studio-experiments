/** Exact type correspondence, independent of labels, selection and graph layout. */
export function conceptType(concept: { kind?: string; type?: { label?: string }; label?: string } | null | undefined): string | null {
    if (!concept) return null;
    return concept.kind?.endsWith('Type') ? concept.label ?? null : concept.type?.label ?? null;
}
export function correspondsToType(concept: { kind?: string; type?: { label?: string }; label?: string } | null | undefined,
    label: string, schema: boolean): boolean {
    return !!concept && !!concept.kind && concept.kind.endsWith('Type') === schema && conceptType(concept) === label;
}
