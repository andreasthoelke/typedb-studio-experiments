import type { Schema, SchemaConcept, SchemaRole } from "../../service/schema-state.service";

export type SchemaExplorerType = SchemaConcept | SchemaRole;
export interface SchemaExplorerSection {
    title: string;
    types: SchemaExplorerType[];
}

/** Connections from the loaded schema, including inherited owns/plays/relates. */
export function schemaExplorerSections(schema: Schema, selected: SchemaExplorerType): SchemaExplorerSection[] {
    const sections: SchemaExplorerSection[] = [];
    const add = (title: string, types: SchemaExplorerType[]) => {
        const unique = new Map(types.map(type => [type.label, type]));
        if (unique.size) sections.push({ title, types: [...unique.values()].sort((a, b) => a.label.localeCompare(b.label)) });
    };
    const relations = Object.values(schema.relations);
    const owners = [...Object.values(schema.entities), ...relations];
    if (selected.kind !== "roleType") {
        add("Supertype", selected.supertype ? [selected.supertype] : []);
        add("Subtypes", selected.subtypes);
    }
    if (selected.kind === "entityType" || selected.kind === "relationType") {
        add("Attributes", selected.ownedAttributes);
        add("Plays roles", selected.playedRoles);
        add("Relations", selected.playedRoles.flatMap(role => {
            const relation = schema.relations[role.label.split(":")[0]];
            return relation ? [relation] : [];
        }));
    }
    if (selected.kind === "relationType") add("Relates roles", selected.relatedRoles);
    if (selected.kind === "attributeType") {
        add("Owners", owners.filter(type => type.ownedAttributes.some(attr => attr.label === selected.label)));
    }
    if (selected.kind === "roleType") {
        add("Relations", relations.filter(type => type.relatedRoles.some(role => role.label === selected.label)));
        add("Role players", owners.filter(type => type.playedRoles.some(role => role.label === selected.label)));
    }
    return sections;
}
