/** Builds single-statement attribute edits for one owner. The owner is anchored
 * by iid *and* type (TypeDB cannot infer types from an iid alone), and the old
 * value is matched by value, so an edit made elsewhere yields zero rows —
 * "nothing changed" — instead of touching a different value. */

export type AttributeValueType = "boolean" | "integer" | "double" | "decimal" | "string"
    | "date" | "datetime" | "datetime-tz" | "duration" | string;

const quotedLabel = (label: string) => /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(label) ? label : `\`${label.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;

/** A TypeQL literal for a value typed by the user (or read back from the
 * server). Throws with a readable message when the text does not fit. */
export function typeqlLiteral(valueType: AttributeValueType | undefined, input: unknown): string {
    const text = typeof input === "string" ? input : String(input);
    switch (valueType) {
        case "string": case undefined:
            return JSON.stringify(text);
        case "boolean": {
            const value = text.trim().toLowerCase();
            if (value !== "true" && value !== "false") throw new Error("Enter true or false.");
            return value;
        }
        case "integer": {
            const value = text.trim();
            if (!/^[+-]?\d+$/.test(value)) throw new Error("Enter a whole number.");
            return value;
        }
        case "double": case "decimal": {
            const value = text.trim().replace(/dec$/, "");
            if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) throw new Error("Enter a number.");
            if (valueType === "decimal") return `${value}dec`;
            return /[.eE]/.test(value) ? value : `${value}.0`;
        }
        default: {
            // Temporal literals are unquoted; allow only their own characters.
            const value = text.trim();
            if (!value || !/^[0-9A-Za-z:+\-.\/_\[\]]+$/.test(value)) throw new Error(`Enter a ${valueType} literal, e.g. 2024-05-01T10:00:00.`);
            return value;
        }
    }
}

export interface AttributeEdit {
    ownerIid: string;
    ownerType: string;
    attribute: string;
    valueType?: AttributeValueType;
    /** Absent: add a value. */
    oldValue?: unknown;
    /** Absent: remove the old value. */
    newValue?: string;
}

export function attributeEditQuery(edit: AttributeEdit): string {
    if (!/^0x[\da-f]+$/i.test(edit.ownerIid)) throw new Error("This node has no database iid.");
    if (edit.oldValue === undefined && edit.newValue === undefined) throw new Error("Nothing to change.");
    const owner = `$x iid ${edit.ownerIid}, isa ${quotedLabel(edit.ownerType)};`;
    const attribute = quotedLabel(edit.attribute);
    const insert = edit.newValue === undefined ? "" : ` insert $x has ${attribute} ${typeqlLiteral(edit.valueType, edit.newValue)};`;
    if (edit.oldValue === undefined) return `match ${owner}${insert}`;
    return `match ${owner} $x has ${attribute} $old; $old == ${typeqlLiteral(edit.valueType, edit.oldValue)}; delete has $old of $x;${insert}`;
}
