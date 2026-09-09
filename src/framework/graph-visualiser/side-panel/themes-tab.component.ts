import { Component, inject, Input } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatMenuModule } from "@angular/material/menu";
import { GraphStyleService, CustomPreset } from "../../../service/graph-style.service";
import { GraphVisualiser } from "../engine";

@Component({
    selector: "ts-graph-styles-themes-tab",
    templateUrl: "themes-tab.component.html",
    styleUrls: ["graph-side-panel.component.scss"],
    imports: [FormsModule, MatMenuModule],
})
export class ThemesTabComponent {
    importMessage = "";
    importError = false;

    async importPresets(event: Event): Promise<void> {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        try {
            if (file.size > 1024 * 1024) throw new Error("Preset file exceeds 1 MiB.");
            const count = this.styleService.importPresets(await file.text());
            this.importError = false;
            this.importMessage = `Imported ${count} preset${count === 1 ? '' : 's'}. Choose Apply to use one.`;
        } catch (error) {
            this.importError = true;
            this.importMessage = error instanceof Error ? error.message : "Could not import presets.";
        } finally { input.value = ""; }
    }

    exportPresets(name?: string): void {
        const url = URL.createObjectURL(new Blob([this.styleService.exportPresets(name)], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `${name?.replace(/[^a-z0-9_-]+/gi, '-') || 'studio-graph-presets'}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    @Input() visualiser: GraphVisualiser | null = null;

    styleService = inject(GraphStyleService);

    get activePreset(): string | null {
        return this.styleService.activePreset;
    }

    appliedPreset: string | null = null;
    private appliedTimer: ReturnType<typeof setTimeout> | null = null;

    applyPreset(preset: "default" | "cal" | "structure" | "uniform" | "classic" | "grayscale"): void {
        if (preset === "default") {
            this.styleService.applyDefaultPreset();
            this.visualiser?.restoreLabels();
            this.visualiser?.applyEdgeStyleUpdate();
            this.visualiser?.applyEdgeCurvature();
            this.visualiser?.colorEdgesByConstraintIndex(true);
        } else if (preset === "cal") {
            this.styleService.applyCalAestheticsPreset();
            this.visualiser?.restoreLabels();
            this.visualiser?.applyEdgeStyleUpdate();
            this.visualiser?.applyEdgeCurvature();
        } else if (preset === "structure") {
            this.styleService.applyStructurePreset();
            this.visualiser?.applyStructureMode();
            this.visualiser?.applyEdgeCurvature();
        } else if (preset === "uniform") {
            this.styleService.applyUniformPreset();
            this.visualiser?.restoreLabels();
            this.visualiser?.applyEdgeCurvature();
        } else if (preset === "classic") {
            this.styleService.applyClassicPreset();
            this.visualiser?.restoreLabels();
            this.visualiser?.applyEdgeCurvature();
        } else if (preset === "grayscale") {
            this.styleService.applyGrayscalePreset();
            this.visualiser?.restoreLabels();
            this.visualiser?.applyEdgeCurvature();
        }
        if (this.appliedTimer) clearTimeout(this.appliedTimer);
        this.appliedPreset = preset;
        this.appliedTimer = setTimeout(() => { this.appliedPreset = null; }, 2000);
    }

    // -- Custom presets --

    get customPresets(): readonly CustomPreset[] {
        return this.styleService.customPresets;
    }

    savingPreset = false;
    newPresetName = "";
    newPresetDescription = "";

    startSavingPreset(): void {
        this.savingPreset = true;
        this.newPresetName = "";
        this.newPresetDescription = "";
    }

    confirmSavePreset(): void {
        const name = this.newPresetName.trim();
        if (!name) return;
        this.styleService.saveCustomPreset(name, this.newPresetDescription.trim());
        this.savingPreset = false;
        this.newPresetName = "";
        this.newPresetDescription = "";
    }

    cancelSavePreset(): void {
        this.savingPreset = false;
        this.newPresetName = "";
        this.newPresetDescription = "";
    }

    applyCustomPreset(name: string): void {
        this.styleService.applyCustomPreset(name);
        this.visualiser?.restoreLabels();
        this.visualiser?.applyEdgeStyleUpdate();
        this.visualiser?.applyEdgeCurvature();
        if (this.appliedTimer) clearTimeout(this.appliedTimer);
        this.appliedPreset = `custom:${name}`;
        this.appliedTimer = setTimeout(() => { this.appliedPreset = null; }, 2000);
    }

    editingPreset: string | null = null;
    editPresetName = "";
    editPresetDescription = "";

    startEditPreset(name: string): void {
        const preset = this.customPresets.find(p => p.name === name);
        if (!preset) return;
        this.editingPreset = name;
        this.editPresetName = preset.name;
        this.editPresetDescription = preset.description;
    }

    confirmEditPreset(originalName: string): void {
        const name = this.editPresetName.trim();
        if (!name) return;
        this.styleService.renameCustomPreset(originalName, name, this.editPresetDescription.trim());
        this.editingPreset = null;
    }

    cancelEditPreset(): void {
        this.editingPreset = null;
    }

    overwrittenPreset: string | null = null;
    private overwrittenTimer: ReturnType<typeof setTimeout> | null = null;

    overwriteCustomPreset(name: string): void {
        const preset = this.customPresets.find(p => p.name === name);
        if (!preset) return;
        this.styleService.saveCustomPreset(name, preset.description);
        if (this.overwrittenTimer) clearTimeout(this.overwrittenTimer);
        this.overwrittenPreset = name;
        this.overwrittenTimer = setTimeout(() => { this.overwrittenPreset = null; }, 2000);
    }

    deleteCustomPreset(name: string): void {
        this.styleService.deleteCustomPreset(name);
    }
}
