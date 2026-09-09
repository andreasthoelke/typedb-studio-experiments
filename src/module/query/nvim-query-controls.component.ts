import { Component, HostBinding, inject, Input } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { MatMenuModule } from "@angular/material/menu";
import { MatTooltipModule } from "@angular/material/tooltip";
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
            <mat-label>Relation types (comma-separated)</mat-label>
            <input matInput [(ngModel)]="bridge.relationTypes" placeholder="All relation types">
          </mat-form-field>
          <p>{{ bridge.note }}</p>
          <p>One relation hop. Selected relations include their role players. Existing row limits are preserved.</p>
          <button mat-stroked-button (click)="bridge.reapply()">Apply to latest Neovim query</button>
        </div>
      </mat-menu>
    `,
    styleUrls: ["./nvim-query-controls.component.scss"],
    imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule,
        MatInputModule, MatMenuModule, MatTooltipModule],
})
export class NvimQueryControlsComponent {
    @HostBinding("class.floating") @Input() floating = false;
    bridge = inject(NvimQueryBridge);

    onSettingsKeydown(event: KeyboardEvent): void {
        // Let Escape close the menu, while text fields keep their own arrow keys.
        if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
    }
}
