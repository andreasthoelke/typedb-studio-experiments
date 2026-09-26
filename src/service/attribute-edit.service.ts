import { Injectable, inject } from "@angular/core";
import { Subject, firstValueFrom } from "rxjs";
import { isApiErrorResponse } from "@typedb/driver-http";
import { attributeEditQuery, typeqlLiteral, type AttributeEdit } from "../framework/util/attribute-edit";
import type { GraphVisualiser } from "../framework/graph-visualiser/engine";
import { DriverState } from "./driver-state.service";
import { SchemaState } from "./schema-state.service";

export interface AttributeEditResult { ok: boolean; message: string; query?: string }

/** Direct attribute writes from the Explorer and Data tab. Each edit is one
 *  auto-committed write, sent once: a lost response is reported as an unknown
 *  outcome and never retried. */
@Injectable({ providedIn: "root" })
export class AttributeEditService {
    private driver = inject(DriverState);
    private schema = inject(SchemaState);
    /** Owner iids whose attributes changed, so inspectors can re-read them. */
    readonly edited$ = new Subject<string>();
    busy = false;

    valueType(attribute: string): string | undefined {
        return (this.schema.value$.value?.attributes[attribute] as { valueType?: string } | undefined)?.valueType;
    }

    /** Validate typed text before sending; null when it fits. */
    validate(attribute: string, text: string): string | null {
        try { typeqlLiteral(this.valueType(attribute), text); return null; }
        catch (error) { return error instanceof Error ? error.message : String(error); }
    }

    async edit(database: string | undefined, visualiser: GraphVisualiser | null, edit: Omit<AttributeEdit, "valueType">): Promise<AttributeEditResult> {
        if (!database || database !== this.driver.database$.value?.name) return { ok: false, message: "Connect to this graph's database to edit values." };
        if (this.busy) return { ok: false, message: "Another edit is still being written." };
        const valueType = this.valueType(edit.attribute);
        let query: string;
        try { query = attributeEditQuery({ ...edit, valueType }); }
        catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
        this.busy = true;
        try {
            const res = await firstValueFrom(this.driver.writeOnce(query, database));
            if (isApiErrorResponse(res)) return { ok: false, message: res.err.message, query };
            if (edit.oldValue !== undefined && res.ok.answerType === "conceptRows" && !res.ok.answers.length) {
                this.edited$.next(edit.ownerIid);
                return { ok: false, message: `Nothing changed: ${edit.attribute} no longer has that value. The inspector was refreshed.`, query };
            }
            const typed = edit.newValue === undefined ? undefined : typedValue(valueType, edit.newValue);
            visualiser?.applyAttributeEdit(edit.ownerIid, edit.attribute, edit.oldValue, typed);
            this.edited$.next(edit.ownerIid);
            return { ok: true, message: edit.newValue === undefined ? `Removed ${edit.attribute}.` : `Saved ${edit.attribute}.`, query };
        } catch (error) {
            this.edited$.next(edit.ownerIid);
            return { ok: false, message: `Outcome unknown (${error instanceof Error ? error.message : String(error)}). Not retried; the inspector was re-read.`, query };
        } finally {
            this.busy = false;
        }
    }
}

function typedValue(valueType: string | undefined, text: string): unknown {
    if (valueType === "integer" || valueType === "double") return Number(text.trim());
    if (valueType === "boolean") return text.trim().toLowerCase() === "true";
    return valueType === "string" || valueType === undefined ? text : text.trim();
}
