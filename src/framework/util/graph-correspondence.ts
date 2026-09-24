/** Exact type correspondence, independent of labels, selection and graph layout. */
export function conceptType(concept: { kind?: string; type?: { label?: string }; label?: string } | null | undefined): string | null {
    if (!concept) return null;
    return concept.kind?.endsWith('Type') ? concept.label ?? null : concept.type?.label ?? null;
}
export function correspondsToType(concept: { kind?: string; type?: { label?: string }; label?: string } | null | undefined,
    label: string, schema: boolean): boolean {
    return !!concept && !!concept.kind && concept.kind.endsWith('Type') === schema && conceptType(concept) === label;
}

interface HierarchyType { label: string; supertype?: HierarchyType; subtypes: HierarchyType[] }
export interface TypeHierarchy { entities: Record<string, HierarchyType>; relations: Record<string, HierarchyType>; attributes: Record<string, HierarchyType> }

/** The isa closure used by cross-view carets. Instances of a type include the
 * instances of every subtype (`down`); a type node corresponds to its own type
 * and every supertype an instance of it also belongs to (`up`). The label
 * itself is always first. Unknown labels only match themselves. */
export function isaRelatives(label: string, schema: TypeHierarchy | null | undefined, direction: 'up' | 'down'): string[] {
    const root = schema && (schema.entities[label] ?? schema.relations[label] ?? schema.attributes[label]);
    const labels = [label];
    if (!root) return labels;
    const seen = new Set(labels);
    const pending: HierarchyType[] = direction === 'down' ? [...root.subtypes] : root.supertype ? [root.supertype] : [];
    while (pending.length) {
        const type = pending.shift()!;
        if (seen.has(type.label)) continue;
        seen.add(type.label); labels.push(type.label);
        if (direction === 'down') pending.push(...type.subtypes);
        else if (type.supertype) pending.push(type.supertype);
    }
    return labels;
}
