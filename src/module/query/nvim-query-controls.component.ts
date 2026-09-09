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

@Component({
    selector: "ts-nvim-query-controls",
    template: `
      <button mat-stroked-button [matMenuTriggerFor]="settings" [matTooltip]="bridge.message">
        Neovim{{ bridge.connected ? '' : ' · disconnected' }}
      </button>
      <mat-menu #settings="matMenu">
        <div class="settings" (click)="$event.stopPropagation()" (keydown)="onSettingsKeydown($event)">
          <p role="status">{{ bridge.message }}</p>
          <mat-checkbox [(ngModel)]="bridge.neighbours">Include linked neighbours</mat-checkbox>
          <mat-form-field>
            <mat-label>Seed variable (blank = automatic)</mat-label>
            <input matInput [(ngModel)]="bridge.seedVariable" placeholder="$item">
          </mat-form-field>
          <mat-form-field>
            <mat-label>Relation types</mat-label>
            <mat-select multiple [ngModel]="selectedRelations" (ngModelChange)="selectRelations($event)" placeholder="All relation types">
              @for (label of availableRelations; track label) { <mat-option [value]="label">{{ label }}</mat-option> }
            </mat-select>
            <mat-hint>None selected includes all types.</mat-hint>
          </mat-form-field>
          <p>{{ bridge.note }}</p>
          <p>One relation hop. Selected relations include their role players. Existing row limits are preserved.</p>
          <button mat-stroked-button (click)="bridge.reapply()">Apply to latest Neovim query</button>
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

    get availableRelations(): string[] {
        return Object.keys(this.schema.value$.value?.relations ?? {}).sort();
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
    }

    onSettingsKeydown(event: KeyboardEvent): void {
        // Let Escape close the menu, while text fields keep their own arrow keys.
        if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
    }
}
