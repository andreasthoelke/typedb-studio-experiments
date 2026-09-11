import { Component, HostBinding, inject, Input } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { MatMenuModule } from "@angular/material/menu";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatSelectModule } from "@angular/material/select";
import { SchemaState } from "../../service/schema-state.service";
import { NvimQueryBridge } from "../../service/nvim-query-bridge.service";
import { operationTypes } from "../../framework/util/operation-context";
import { findGraphContextSeed, GraphContextSeed, isGraphContextRelationCompatible } from "../../framework/util/graph-query";

@Component({
    selector: "ts-nvim-query-controls",
    template: `
      <button mat-stroked-button [matMenuTriggerFor]="settings" [matTooltip]="bridge.message">
        Neovim{{ bridge.lastRequest?.execution?.status === 'error' ? ' · failed statement' : '' }}{{ bridge.connected ? '' : ' · disconnected' }}
      </button>
      <mat-menu #settings="matMenu">
        <div class="settings" (click)="$event.stopPropagation()" (keydown)="onSettingsKeydown($event)">
          <p role="status">{{ bridge.message }}</p>
          <mat-checkbox [(ngModel)]="bridge.neighbours" (ngModelChange)="bridge.scheduleReapply()">Include linked neighbours</mat-checkbox>
          @if (bridge.lastRequest?.execution?.kind !== 'schema') {
          <mat-form-field>
            <mat-label>Seed variable (blank = automatic)</mat-label>
            <input matInput [(ngModel)]="bridge.seedVariable" (ngModelChange)="bridge.scheduleReapply()" placeholder="$item">
          </mat-form-field>
          }
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>Relation types</mat-label>
            <mat-select multiple [ngModel]="selectedRelations" (ngModelChange)="selectRelations($event)" placeholder="All relation types">
              @for (choice of availableRelations; track choice.label) {
                <mat-option [value]="choice.label" [disabled]="!choice.compatible && !selectedRelations.includes(choice.label)">
                  {{ choice.label }}{{ choice.compatible ? '' : ' (not compatible with seed)' }}
                </mat-option>
              }
            </mat-select>
            <mat-hint>No selection includes all compatible types. Filters apply to entity seeds.</mat-hint>
          </mat-form-field>
          @if (selectedRelations.length) {
            <button mat-stroked-button (click)="selectRelations([])">Clear relation filter</button>
          }
          <p>{{ bridge.note }}</p>
          @if (bridge.lastRequest?.execution) {
            <p>{{ bridge.outcome }}</p>
            <details>
              <summary>Original Neovim statement and result</summary>
              <pre>{{ bridge.lastRequest?.query }}</pre>
              @if (bridge.lastRequest?.execution?.error) { <pre>{{ bridge.lastRequest?.execution?.error }}</pre> }
            </details>
          }
          <p>One relation hop. Selected relations include their role players. Existing row limits are preserved.</p>
          <p>Changes automatically update the latest Neovim query.</p>
        </div>
      </mat-menu>
    `,
    styleUrls: ["./nvim-query-controls.component.scss"],
    imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule,
        MatInputModule, MatMenuModule, MatTooltipModule, MatSelectModule],
})
export class NvimQueryControlsComponent {
    @HostBinding("class.floating") @Input() floating = false;
    bridge = inject(NvimQueryBridge);
    private schema = inject(SchemaState);
    private relationText?: string;
    private relationSelection: string[] = [];

    get availableRelations(): { label: string; compatible: boolean }[] {
        const schema = this.schema.value$.value;
        if (this.bridge.operationContext && schema) {
            const types = operationTypes(this.bridge.lastRequest!.query, schema);
            return Object.keys(schema.relations).sort().map(label => ({ label,
                compatible: this.bridge.lastRequest?.execution?.kind === "schema" || types.some(type =>
                    type.kind !== "attributeType" && isGraphContextRelationCompatible({ variable: "$item", type: { ...type, kind: "entityType" }, exact: false }, schema.relations[label])),
            }));
        }
        let seed: GraphContextSeed | undefined;
        try {
            seed = findGraphContextSeed(this.bridge.lastRequest?.query ?? "", this.bridge.seedVariable,
                label => schema?.entities[label] ?? schema?.relations[label] ?? schema?.attributes[label]);
        } catch { /* The query runner reports invalid query text or seed settings. */ }
        return Object.keys(schema?.relations ?? {}).sort().map(label => ({ label,
            compatible: !seed || isGraphContextRelationCompatible(seed, schema!.relations[label]),
        }));
    }

    get selectedRelations(): string[] {
        // NgModel schedules updates when array identity changes; retain it across view checks.
        if (this.relationText !== this.bridge.relationTypes) {
            this.relationText = this.bridge.relationTypes;
            this.relationSelection = this.relationText.split(",").map(label => label.trim()).filter(Boolean);
        }
        return this.relationSelection;
    }

    selectRelations(labels: string[]): void {
        this.bridge.relationTypes = labels.join(", ");
        this.bridge.scheduleReapply();
    }

    onSettingsKeydown(event: KeyboardEvent): void {
        // Let Escape close the menu, while text fields keep their own arrow keys.
        if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
    }
}
