import type { CustomPreset, PartialNodeStyle, GraphBackground } from "../../service/graph-style.service";

const FORMAT = "typedb-studio-graph-presets";
const shapes = ["rounded-rect", "diamond", "hexagon", "ellipse"];
const kinds = ["entity", "relation", "attribute", "entityType", "relationType", "attributeType", "roleType", "value", "unavailable"];
const unsafeKeys = ["__proto__", "prototype", "constructor"];

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a preset object.");
    return value as Record<string, unknown>;
}
function string(value: unknown, max = 200): string {
    if (typeof value !== "string" || value.length > max) throw new Error("Invalid preset text.");
    return value;
}
function color(value: unknown): string {
    const text = string(value, 9);
    if (!/^#[0-9a-f]{6}$/i.test(text)) throw new Error("Preset colours must use six-digit hex values.");
    return text;
}
function number(value: unknown, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("Preset size or opacity is out of range.");
    return value;
}
function boolean(value: unknown): boolean {
    if (typeof value !== "boolean") throw new Error("Invalid preset option.");
    return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
    if (!values.includes(value as T)) throw new Error(`Unsupported preset option: ${String(value)}`);
    return value as T;
}
function map<T>(value: unknown, parse: (entry: unknown) => T, allowedKeys?: string[]): Record<string, T> {
    const entries = Object.entries(record(value));
    if (entries.length > 2000) throw new Error("Too many style overrides.");
    return Object.fromEntries(entries.map(([key, entry]) => {
        if (!key || key.length > 256 || unsafeKeys.includes(key) || (allowedKeys && !allowedKeys.includes(key))) throw new Error("Invalid style key.");
        return [key, parse(entry)];
    }));
}
function style(value: unknown): PartialNodeStyle {
    const input = record(value);
    const result: PartialNodeStyle = {};
    if (input["color"] !== undefined) result.color = color(input["color"]);
    if (input["shape"] !== undefined) result.shape = choice(input["shape"], shapes);
    if (input["width"] !== undefined) result.width = number(input["width"], 1, 1000);
    if (input["height"] !== undefined) result.height = number(input["height"], 1, 1000);
    return result;
}
function preset(value: unknown): CustomPreset {
    const p = record(value);
    const bg = record(p["background"]);
    const background: GraphBackground = {
        type: choice(bg["type"], ["default", "solid", "gradient", "grid", "dots", "party"] as const),
        color1: color(bg["color1"]), color2: color(bg["color2"]), gradientAngle: number(bg["gradientAngle"], -360, 360),
    };
    if (bg["themed"] !== undefined) background.themed = boolean(bg["themed"]);
    const name = string(p["name"]).trim();
    if (!name) throw new Error("A preset needs a name.");
    const result: CustomPreset = {
        name, description: string(p["description"] ?? "", 2000), background,
        kindStyles: map(p["kindStyles"], style, kinds), typeStyles: map(p["typeStyles"], style),
        edgeLabelColors: map(p["edgeLabelColors"], color),
        colorEdgesByConstraint: boolean(p["colorEdgesByConstraint"]), labelsVisible: boolean(p["labelsVisible"]),
        showHoverLabel: boolean(p["showHoverLabel"]), degreeScaling: boolean(p["degreeScaling"]),
    };
    if (p["defaultEdgeColor"] !== undefined) result.defaultEdgeColor = p["defaultEdgeColor"] === null ? null : color(p["defaultEdgeColor"]);
    if (p["labelColorMode"] !== undefined) result.labelColorMode = choice(p["labelColorMode"], ["auto", "border", "fixed"] as const);
    if (p["labelUseBorderColor"] !== undefined) result.labelUseBorderColor = boolean(p["labelUseBorderColor"]);
    if (p["edgeLabelsVisible"] !== undefined) result.edgeLabelsVisible = boolean(p["edgeLabelsVisible"]);
    if (p["edgesCurvedByDefault"] !== undefined) result.edgesCurvedByDefault = boolean(p["edgesCurvedByDefault"]);
    if (p["fillOpacity"] !== undefined) result.fillOpacity = number(p["fillOpacity"], 0, 1);
    return result;
}

/** Validate the entire import before touching saved presets; accept legacy raw exports too. */
export function parseGraphPresets(text: string): CustomPreset[] {
    if (text.length > 1024 * 1024) throw new Error("Preset file exceeds 1 MiB.");
    const input = JSON.parse(text);
    let entries: unknown[];
    if (Array.isArray(input)) entries = input;
    else {
        const object = record(input);
        if (object["format"] !== undefined) {
            if (object["format"] !== FORMAT || object["version"] !== 1 || !Array.isArray(object["presets"])) throw new Error("Unsupported preset file format or version.");
            entries = object["presets"];
        } else entries = [object];
    }
    if (!entries.length || entries.length > 100) throw new Error("Import between 1 and 100 presets at a time.");
    return entries.map(preset);
}

export function exportGraphPresets(presets: readonly CustomPreset[]): string {
    return JSON.stringify({ format: FORMAT, version: 1, presets }, null, 2) + "\n";
}

/** Preserve existing names and contents, adding a suffix for imported duplicates. */
export function mergeGraphPresets(existing: readonly CustomPreset[], incoming: readonly CustomPreset[]): CustomPreset[] {
    const result = structuredClone([...existing]);
    const names = new Set(result.map(p => p.name));
    for (const p of incoming) {
        let name = p.name;
        let suffix = 2;
        while (names.has(name)) name = `${p.name} (${suffix++})`;
        names.add(name);
        result.push({ ...structuredClone(p), name });
    }
    return result;
}
