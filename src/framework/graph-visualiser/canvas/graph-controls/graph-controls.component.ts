import { AsyncPipe } from "@angular/common";
import { Component, EventEmitter, Input, Output } from "@angular/core";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatMenuModule } from "@angular/material/menu";
import { GraphVisualiser } from "../../engine";
import { LayoutDensity } from "../../engine/layout";

@Component({
    selector: "ts-graph-controls",
    templateUrl: "graph-controls.component.html",
    styleUrls: ["graph-controls.component.scss"],
    imports: [MatTooltipModule, MatMenuModule, AsyncPipe],
})
export class GraphControlsComponent {

    @Input() visualiser: GraphVisualiser | null = null;
    @Input() queryRunning = false;
    @Input() hasChanges = false;

    @Output() resetChangesClicked = new EventEmitter<void>();

    redrawCooldown = false;
    private cooldownTimer: ReturnType<typeof setTimeout> | null = null;

    zoomIn(): void {
        this.visualiser?.zoom("in");
    }

    zoomOut(): void {
        this.visualiser?.zoom("out");
    }

    /** When something is selected, frame it; otherwise reset to the global view. */
    resetOrFocus(): void {
        if (this.visualiser && (this.visualiser.elementSelection.active || this.visualiser.highlightedNodeKeys().length)) {
            this.visualiser.focusHighlightedNodes();
        } else {
            this.visualiser?.centerCamera();
        }
    }

    stopLayout(): void {
        this.visualiser?.stopLayout();
        this.redrawCooldown = true;
        if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
        this.cooldownTimer = setTimeout(() => { this.redrawCooldown = false; }, 1000);
    }

    reLayout(): void {
        this.visualiser?.reLayout();
    }

    setDensity(mode: LayoutDensity): void {
        this.visualiser?.setLayoutDensity(mode);
    }

    /** The currently-applied density, for marking the active menu item. */
    get density(): LayoutDensity {
        return this.visualiser?.layoutDensity ?? "default";
    }

    /** Whether the density menu can be used: graph present and not mid-run. */
    get canSetDensity(): boolean {
        return !this.queryRunning
            && !this.visualiser?.isLayoutRunning
            && (this.visualiser?.graph.order ?? 0) > 0;
    }
}
