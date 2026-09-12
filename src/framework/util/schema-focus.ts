import { tokens } from "./graph-query";
import type { Schema, SchemaConcept } from "../../service/schema-state.service";

/** A bounded schema neighborhood, derived from source text, never from instance counts.
 * Include a seed's relations and their players, without expanding the players' other relations.
 * Ancestor paths keep inherited owns/plays/relates edges connected in the actual schema graph.
 */
export function schemaFocus(source: string, schema: Schema): { seeds: string[]; labels: Set<string> } {
    const types: Record<string, SchemaConcept> = { ...schema.entities, ...schema.relations, ...schema.attributes };
    const seeds = [...new Set(tokens(source, true, true).flatMap(token => {
        const label = token.kind === "word" ? token.text
            : token.kind === "literal" && token.text.startsWith("`") ? token.text.slice(1, -1) : "";
        return Object.hasOwn(types, label) ? [label] : [];
    }))];
    const labels = new Set(seeds);
    const owners = [...Object.values(schema.entities), ...Object.values(schema.relations)];
    const relations = Object.values(schema.relations);
    const selectedRelations = new Set<string>();
    for (const label of seeds) {
        const type = types[label];
        for (const child of type.subtypes) labels.add(child.label);
        if (type.kind === "attributeType") {
            for (const owner of owners) if (owner.ownedAttributes.some(attr => attr.label === label)) labels.add(owner.label);
        } else {
            for (const attr of type.ownedAttributes) labels.add(attr.label);
            if (type.kind === "relationType") selectedRelations.add(label);
            const roles = new Set(type.playedRoles.map(role => role.label));
            for (const relation of relations) if (relation.relatedRoles.some(role => roles.has(role.label))) selectedRelations.add(relation.label);
        }
    }
    for (const label of selectedRelations) {
        const relation = schema.relations[label];
        labels.add(label);
        const roles = new Set(relation.relatedRoles.map(role => role.label));
        for (const role of roles) labels.add(role);
        for (const owner of owners) if (owner.playedRoles.some(role => roles.has(role.label))) labels.add(owner.label);
    }
    for (const label of [...labels]) {
        let parent = types[label]?.supertype;
        const seen = new Set<string>();
        while (parent && !seen.has(parent.label)) {
            seen.add(parent.label);
            labels.add(parent.label);
            parent = parent.supertype;
        }
    }
    return { seeds, labels };
}
