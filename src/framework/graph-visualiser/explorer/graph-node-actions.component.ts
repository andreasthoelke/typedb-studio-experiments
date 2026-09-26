import { Component, EventEmitter, Input, Output } from "@angular/core";
import { MatTooltipModule } from "@angular/material/tooltip";
import { GraphVisualiser } from "../engine";

/** One icon strip for a node or node set, wherever it appears (Explorer header,
 *  links, relations, attributes, Data rows, the selection). Each glyph shows a
 *  state and toggles it: go to (caret), visible, selected, marked; × removes
 *  from the view. Nothing here writes the database. */
@Component({
    selector: "ts-node-actions",
    templateUrl: "./graph-node-actions.component.html",
    styleUrls: ["./graph-node-actions.component.scss"],
    imports: [MatTooltipModule],
})
export class GraphNodeActionsComponent {
    @Input() visualiser: GraphVisualiser | null = null;
    @Input() keys: (string | null | undefined)[] = [];
    /** Offer Add (load from the database) — also alongside loaded glyphs when only part is loaded. */
    @Input() addable = false;
    @Input() addLabel = "Add to graph";
    /** What the strip addresses, for tooltips and screen readers ("this node", "3 selected nodes"). */
    @Input() subject = "";
    @Input() removable = true;
    @Output() add = new EventEmitter<void>();

    get present(): string[] {
        const v = this.visualiser;
        return v ? [...new Set(this.keys.filter((key): key is string => !!key && v.graph.hasNode(key)))] : [];
    }
    private every(test: (key: string) => boolean): boolean { const keys = this.present; return keys.length > 0 && keys.every(test); }
    get isCaret(): boolean { const caret = this.visualiser?.navigation.caret; return !!caret && this.present.includes(caret); }
    get hidden(): boolean { return this.every(key => !!this.visualiser!.graph.getNodeAttribute(key, "viewHidden")); }
    get selected(): boolean { return this.every(key => this.visualiser!.isExplicitlySelected(key)); }
    get marked(): boolean { return this.every(key => this.visualiser!.isMarked(key)); }
    get many(): boolean { return this.present.length > 1; }
    label(action: string): string { return this.subject ? `${action} ${this.subject}` : action; }

    goTo(): void { this.visualiser?.goToNodes(this.present); }
    toggleHidden(): void { this.visualiser?.setNodesHidden(this.present, !this.hidden); }
    toggleSelected(): void { this.visualiser?.setNodesSelected(this.present, !this.selected); }
    toggleMarked(): void { this.visualiser?.setMarked(this.present, !this.marked); }
    remove(): void { this.visualiser?.removeNodesFromGraph(this.present); }
}
