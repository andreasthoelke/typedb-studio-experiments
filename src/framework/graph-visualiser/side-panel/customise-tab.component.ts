import { edgeRoleLabel, edgeStyleKey } from "../../util/graph-edge";
import { LINE_STYLE_OPTIONS, LineStyle } from "../../util/line-style";
import { AfterViewChecked, Component, DoCheck, ElementRef, inject, Input, OnChanges, OnDestroy, SimpleChanges } from "@angular/core";
import { CommonModule } from "@angular/common";
import { MatSelectModule } from "@angular/material/select";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { GraphStyleService, GraphBackgroundType, DEFAULT_BACKGROUND } from "../../../service/graph-style.service";
import { GraphVisualiser } from "../engine";
import { VertexKind } from "@typedb/graph-utils";

import { StorageService } from "../../../service/storage.service";

type CustomiseSection = "settings" | "kinds" | "types" | "edges";
const SECTION_DEFAULTS: Record<CustomiseSection, boolean> = { settings: false, kinds: false, types: true, edges: false };
const SECTION_STORAGE_KEY = "graphCustomiseSections";

interface KindRow {
    kind: VertexKind;
    label: string;
}

interface TypeRow {
    typeLabel: string;
    kind: VertexKind;
}

interface EdgeLabelRow {
    tag: string;
    displayLabel: string;
}

const DISPLAY_EDGE_LABELS: EdgeLabelRow[] = [
    { tag: "has", displayLabel: "has" },
    { tag: "links", displayLabel: "links" },
    { tag: "isa", displayLabel: "isa" },
    { tag: "isa!", displayLabel: "isa!" },
    { tag: "sub", displayLabel: "sub" },
    { tag: "sub!", displayLabel: "sub!" },
    { tag: "owns", displayLabel: "owns" },
    { tag: "relates", displayLabel: "relates" },
    { tag: "plays", displayLabel: "plays" },
];

const DISPLAY_KINDS: KindRow[] = [
    { kind: "entity", label: "entity" },
    { kind: "relation", label: "relation" },
    { kind: "attribute", label: "attribute" },
    { kind: "entityType", label: "entity type" },
    { kind: "relationType", label: "relation type" },
    { kind: "attributeType", label: "attribute type" },
    { kind: "roleType", label: "role type" },
    { kind: "value", label: "value" },
];

export const AVAILABLE_SHAPES = [
    { value: "rounded-rect", label: "Rectangle" },
    { value: "diamond", label: "Diamond" },
    { value: "hexagon", label: "Hexagon" },
    { value: "ellipse", label: "Ellipse" },
];

const KIND_ORDER: Record<string, number> = Object.fromEntries(DISPLAY_KINDS.map((k, i) => [k.kind, i]));
function kindOrder(kind: string): number { return KIND_ORDER[kind] ?? Infinity; }

@Component({
    selector: "ts-graph-side-panel-customise-tab",
    templateUrl: "customise-tab.component.html",
    styleUrls: ["graph-side-panel.component.scss"],
    imports: [
        CommonModule,
        MatSelectModule, MatTooltipModule,
        MatFormFieldModule, MatInputModule, MatSlideToggleModule,
    ],
})
export class CustomiseTabComponent implements OnChanges, OnDestroy, DoCheck, AfterViewChecked {

    @Input() edgeStyleRequest = 0;
    @Input() visualiser: GraphVisualiser | null = null;

    styleService = inject(GraphStyleService);
    readonly lineStyles = LINE_STYLE_OPTIONS;
    getTypeLineThickness(typeLabel: string): number | string { return this.styleService.typeStyles[typeLabel]?.lineThickness ?? ""; }
    getTypeLineStyle(typeLabel: string): string { return this.styleService.typeStyles[typeLabel]?.lineStyle ?? "inherit"; }
    setTypeLineStyle(typeLabel: string, style: LineStyle | "inherit"): void {
        if (style === "inherit") this.styleService.clearTypeLineStyle(typeLabel);
        else this.styleService.setTypeStyle(typeLabel, { lineStyle: style });
    }
    setEdgeLineStyle(style: LineStyle | "inherit", tag?: string): void {
        this.styleService.setEdgeLineStyle(style === "inherit" ? null : style, tag);
    }
    activeTab: "graph" | "background" = "graph";

    private storage = inject(StorageService);
    private host = inject<ElementRef<HTMLElement>>(ElementRef);
    // UI preferences stay separate from graph styling and captured presets.
    private collapsed = this.storage.read(SECTION_STORAGE_KEY, raw => {
        const result = { ...SECTION_DEFAULTS };
        for (const section of Object.keys(result) as CustomiseSection[]) {
            const value = (raw as Partial<typeof result> | null)?.[section];
            if (typeof value === "boolean") result[section] = value;
        }
        return result;
    });
    get settingsCollapsed() { return this.collapsed.settings; }
    get kindsCollapsed() { return this.collapsed.kinds; }
    get typesCollapsed() { return this.collapsed.types; }
    get edgesCollapsed() { return this.collapsed.edges; }

    toggleSection(section: CustomiseSection): void {
        this.collapsed[section] = !this.collapsed[section];
        this.storage.write(SECTION_STORAGE_KEY, this.collapsed);
        if (section === "types" && !this.typesCollapsed) {
            this.refreshDiscoveredTypes(); this.revealCaretPending = true;
        }
    }

    caretType: string | null = null;
    private roleGraph: GraphVisualiser["graph"] | null = null;
    private rolesDirty = true;
    private markRolesDirty = () => { this.rolesDirty = true; };
    ngOnDestroy(): void {
        this.roleGraph?.off("edgeAdded", this.markRolesDirty);
        this.roleGraph?.off("edgeDropped", this.markRolesDirty);
        this.roleGraph?.off("edgesCleared", this.markRolesDirty);
    }
    private observedVisualiser: GraphVisualiser | null = null;
    private observedCaret: string | null = null;
    private observedOrder = -1;
    private observedSize = -1;
    private observedEdge: string | null = null;
    inspectedEdgeStyle: string | null = null;
    private revealCaretPending = false;

    ngDoCheck(): void {
        const v = this.visualiser, caret = v?.navigation.caret ?? null;
        if (this.roleGraph !== (v?.graph ?? null)) {
            this.ngOnDestroy(); this.roleGraph = v?.graph ?? null; this.rolesDirty = true;
            this.roleGraph?.on("edgeAdded", this.markRolesDirty);
            this.roleGraph?.on("edgeDropped", this.markRolesDirty);
            this.roleGraph?.on("edgesCleared", this.markRolesDirty);
        }
        const edge = v?.interactionHandler.inspectedEdge ?? null;
        const graphChanged = v !== this.observedVisualiser || (v?.graph.order ?? -1) !== this.observedOrder || (v?.graph.size ?? -1) !== this.observedSize;
        if (graphChanged || this.rolesDirty || caret !== this.observedCaret || edge !== this.observedEdge) {
            this.observedSize = v?.graph.size ?? -1; this.observedEdge = edge;
            this.inspectedEdgeStyle = edge && v?.graph.hasEdge(edge) ? edgeStyleKey(v.graph.getEdgeAttributes(edge)) : null;
            this.refreshRoleStyles(); this.rolesDirty = false;
            this.observedVisualiser = v; this.observedOrder = v?.graph.order ?? -1; this.observedCaret = caret;
            const concept = caret && v?.graph.hasNode(caret) ? v.graph.getNodeAttribute(caret, "metadata")?.concept : null;
            this.caretType = concept && "type" in concept ? concept.type.label
                : concept && "label" in concept && !["expression", "functionCall"].includes(concept.kind) ? concept.label : null;
            if (graphChanged) this.refreshDiscoveredTypes();
            else this.recomputeDisplayedTypes();
            this.revealCaretPending = true;
        }
    }

    revealCaretStyle(): void {
        if (this.typesCollapsed) this.toggleSection("types");
        this.activeTab = "graph";
        this.revealCaretPending = true;
    }

    ngAfterViewChecked(): void {
        if (!this.revealCaretPending || (this.inspectedEdgeStyle ? this.edgesCollapsed : this.typesCollapsed) || this.activeTab !== "graph") return;
        this.revealCaretPending = false;
        const row = this.host.nativeElement.querySelector<HTMLElement>(this.inspectedEdgeStyle ? ".style-row.inspected-edge-style" : ".style-row.caret-style");
        const panel = this.host.nativeElement.closest<HTMLElement>(".panel-scroll");
        if (!row || !panel) return;
        // Scroll only this panel; scrollIntoView can also move the graph/page.
        const rect = row.getBoundingClientRect(), box = panel.getBoundingClientRect();
        if (rect.top < box.top) panel.scrollTop -= box.top - rect.top;
        else if (rect.bottom > box.bottom) panel.scrollTop += Math.min(rect.bottom - box.bottom, rect.top - box.top);
    }

    readonly displayKinds = DISPLAY_KINDS;
    readonly shapes = AVAILABLE_SHAPES;
    readonly edgeLabels = DISPLAY_EDGE_LABELS;

    discoveredTypes: TypeRow[] = [];

    /** Filter input for the Types section. Live-narrows the rendered row list — necessary at
     *  scale (some schemas have 10k+ types and rendering a heavy row per type freezes the app). */
    typeFilter = "";
    /** Hard cap on the number of Types rows rendered at once. Smaller than the Elements chip
     *  limit because each Customise row is much heavier than a chip. */
    static readonly TYPE_DISPLAY_LIMIT = 100;
    displayedTypes: TypeRow[] = [];
    typeOverflow = 0;

    roleFilter = "";
    roleStyles: EdgeLabelRow[] = [];
    get filteredRoleStyles(): EdgeLabelRow[] {
        const filter = this.roleFilter.trim().toLocaleLowerCase();
        return this.roleStyles.filter(row => row.tag === this.inspectedEdgeStyle || row.tag.toLocaleLowerCase().includes(filter));
    }
    get displayedRoleStyles(): EdgeLabelRow[] {
        const rows = this.filteredRoleStyles, inspected = rows.find(row => row.tag === this.inspectedEdgeStyle);
        return inspected ? [inspected, ...rows.filter(row => row !== inspected).slice(0, 99)] : rows.slice(0, 100);
    }
    get roleOverflow(): number { return Math.max(0, this.filteredRoleStyles.length - 100); }
    private refreshRoleStyles(): void {
        const roles = new Set<string>();
        this.visualiser?.graph.forEachEdge((_edge, attrs) => { const role = edgeRoleLabel(attrs); if (role) roles.add(role); });
        this.roleStyles = [...roles].sort().map(tag => ({ tag, displayLabel: tag }));
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (changes["edgeStyleRequest"] && this.edgeStyleRequest && this.visualiser?.interactionHandler.inspectedEdge) {
            this.activeTab = "graph"; this.roleFilter = "";
            if (this.edgesCollapsed) this.toggleSection("edges");
            this.revealCaretPending = true;
        }
        if (changes["visualiser"]) {
            this.refreshDiscoveredTypes(); this.refreshRoleStyles();
        }
    }

    refreshDiscoveredTypes(): void {
        if (!this.visualiser) { this.discoveredTypes = []; this.recomputeDisplayedTypes(); return; }
        const typeMap = new Map<string, VertexKind>();
        this.visualiser.graph.nodes().forEach(nodeKey => {
            const attrs = this.visualiser!.graph.getNodeAttributes(nodeKey);
            const concept = attrs.metadata.concept;
            if ("type" in concept && concept.type && "label" in concept.type) {
                typeMap.set(concept.type.label, concept.kind as any);
            } else if ("label" in concept && !["unavailable", "expression", "functionCall"].includes(concept.kind)) {
                typeMap.set((concept as any).label, concept.kind as any);
            }
        });
        this.discoveredTypes = Array.from(typeMap.entries())
            .map(([typeLabel, kind]) => ({ typeLabel, kind }))
            .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.typeLabel.localeCompare(b.typeLabel));
        this.recomputeDisplayedTypes();
    }

    private recomputeDisplayedTypes(): void {
        const needle = this.typeFilter.trim().toLowerCase();
        const matches = needle
            ? this.discoveredTypes.filter(t => t.typeLabel.toLowerCase().includes(needle))
            : this.discoveredTypes;
        const limit = CustomiseTabComponent.TYPE_DISPLAY_LIMIT;
        const caret = this.discoveredTypes.find(row => row.typeLabel === this.caretType);
        // Keep the caret's row reachable even beyond the cap or a manual filter.
        const others = matches.filter(row => row !== caret);
        this.displayedTypes = caret ? [caret, ...others.slice(0, limit - 1)] : others.slice(0, limit);
        this.typeOverflow = Math.max(0, others.length - (limit - (caret ? 1 : 0)));
    }

    onTypeFilterInput(event: Event): void {
        this.typeFilter = (event.target as HTMLInputElement).value;
        this.recomputeDisplayedTypes();
    }

    clearTypeFilter(): void {
        if (!this.typeFilter) return;
        this.typeFilter = "";
        this.recomputeDisplayedTypes();
    }

    // -- Kind getters --

    getKindColor(kind: VertexKind): string {
        return this.styleService.getKindStyle(kind).color;
    }

    getKindShape(kind: VertexKind): string {
        return this.styleService.getKindStyle(kind).shape;
    }

    getKindWidth(kind: VertexKind): number {
        return this.styleService.getKindStyle(kind).width;
    }

    getKindHeight(kind: VertexKind): number {
        return this.styleService.getKindStyle(kind).height;
    }

    // -- Kind setters --

    setKindColor(kind: VertexKind, color: string): void {
        this.styleService.setKindStyle(kind, { color });
        this.applyStyles();
    }

    setKindShape(kind: VertexKind, shape: string): void {
        this.styleService.setKindStyle(kind, { shape });
        this.applyStyles();
    }

    setKindWidth(kind: VertexKind, width: number): void {
        this.styleService.setKindStyle(kind, { width });
        this.applyStyles();
    }

    setKindHeight(kind: VertexKind, height: number): void {
        this.styleService.setKindStyle(kind, { height });
        this.applyStyles();
    }

    hasKindOverride(kind: VertexKind): boolean {
        return this.styleService.hasKindOverride(kind);
    }

    clearKindOverride(kind: VertexKind): void {
        this.styleService.removeKindStyle(kind);
        this.applyStyles();
    }

    // -- Type getters --

    getTypeColor(typeLabel: string, kind: VertexKind): string {
        return this.styleService.resolveNodeStyle(kind, typeLabel).color;
    }

    getTypeShape(typeLabel: string, kind: VertexKind): string {
        return this.styleService.resolveNodeStyle(kind, typeLabel).shape;
    }

    getTypeWidth(typeLabel: string, kind: VertexKind): number {
        return this.styleService.resolveNodeStyle(kind, typeLabel).width;
    }

    getTypeHeight(typeLabel: string, kind: VertexKind): number {
        return this.styleService.resolveNodeStyle(kind, typeLabel).height;
    }

    hasTypeOverride(typeLabel: string): boolean {
        return !!this.styleService.typeStyles[typeLabel];
    }

    // -- Type setters --

    setTypeColor(typeLabel: string, color: string): void {
        this.styleService.setTypeStyle(typeLabel, { color });
        this.applyStyles();
    }

    setTypeShape(typeLabel: string, shape: string): void {
        this.styleService.setTypeStyle(typeLabel, { shape });
        this.applyStyles();
    }

    setTypeWidth(typeLabel: string, width: number): void {
        this.styleService.setTypeStyle(typeLabel, { width });
        this.applyStyles();
    }

    setTypeHeight(typeLabel: string, height: number): void {
        this.styleService.setTypeStyle(typeLabel, { height });
        this.applyStyles();
    }

    clearTypeOverride(typeLabel: string): void {
        this.styleService.removeTypeStyle(typeLabel);
        this.applyStyles();
    }

    // -- Edge label colors --

    getEdgeLabelColor(tag: string): string {
        return this.styleService.getEdgeLabelColor(tag);
    }

    setEdgeLabelColor(tag: string, color: string): void {
        this.styleService.setEdgeLabelColor(tag, color);
        this.visualiser?.applyEdgeStyleUpdate();
    }

    hasEdgeLabelOverride(tag: string): boolean {
        return this.styleService.getRoleArrow(tag) !== "none" || !!this.styleService.edgeLabelColors[tag] || this.styleService.hasEdgeLineStyle(tag) || this.styleService.hasEdgeLineThickness(tag);
    }

    clearEdgeLabelOverride(tag: string): void {
        this.styleService.setRoleArrow(tag, "none");
        this.styleService.removeEdgeLabelColor(tag);
        this.styleService.setEdgeLineStyle(null, tag);
        this.styleService.setEdgeLineThickness(null, tag);
        this.visualiser?.applyEdgeStyleUpdate();
    }

    // -- Default ("all") edge color: applies to every edge without its own
    //    per-label override. --

    getDefaultEdgeColor(): string {
        return this.styleService.defaultEdgeColor;
    }

    setDefaultEdgeColor(color: string): void {
        this.styleService.defaultEdgeColor = color;
        this.visualiser?.applyEdgeStyleUpdate();
    }

    get hasDefaultEdgeColorOverride(): boolean {
        return this.styleService.hasDefaultEdgeColorOverride || this.styleService.getEdgeLineStyle() !== "solid" || this.styleService.getEdgeLineThickness() !== 1;
    }

    clearDefaultEdgeColor(): void {
        this.styleService.clearDefaultEdgeColor();
        this.styleService.setEdgeLineStyle(null);
        this.styleService.setEdgeLineThickness(null);
        this.visualiser?.applyEdgeStyleUpdate();
    }

    // -- Background --

    get backgroundType(): GraphBackgroundType { return this.styleService.background.type; }
    get backgroundColor1(): string { return this.styleService.background.color1; }
    get backgroundColor2(): string { return this.styleService.background.color2; }
    get backgroundAngle(): number { return this.styleService.background.gradientAngle; }

    setBackgroundType(type: GraphBackgroundType): void {
        if (type === "default") {
            this.styleService.updateBackground({ type });
        } else if (type === "grid") {
            this.styleService.updateBackground({ type, color1: "#0e0e0e", color2: "#1a1928" });
        } else if (type === "dots") {
            this.styleService.updateBackground({ type, color1: "#0e0e0e", color2: "#3a3848" });
        } else if (type === "party") {
            this.styleService.updateBackground({ type, color1: "#1a2766", color2: "#cc3344" });
        } else {
            this.styleService.updateBackground({ type });
        }
    }

    get fillOpacityPercent(): number {
        return Math.round(this.styleService.fillOpacity * 100);
    }

    setFillOpacityPercent(percent: number): void {
        this.styleService.fillOpacity = percent / 100;
        this.applyStyles();
    }

    // -- Settings: node label / scaling / edge coloring (moved here from the
    //    side-panel footer so all graph-wide settings live in one place). --

    get nodeLabelsVisible(): boolean {
        return this.styleService.labelsVisible;
    }

    toggleNodeLabels(): void {
        this.styleService.labelsVisible = !this.styleService.labelsVisible;
        this.visualiser?.restoreLabels();
    }

    get nodeLabelColor(): "auto" | "fixed" {
        return this.styleService.labelColorMode === "fixed" ? "fixed" : "auto";
    }

    setNodeLabelColor(mode: "auto" | "fixed"): void {
        this.styleService.labelColorMode = mode;
        this.visualiser?.restoreLabels();
    }

    get showHoverLabel(): boolean {
        return this.styleService.showHoverLabel;
    }

    toggleShowHoverLabel(): void {
        this.styleService.showHoverLabel = !this.styleService.showHoverLabel;
        this.visualiser?.restoreLabels();
    }

    get edgeLabelsVisible(): boolean {
        return this.styleService.edgeLabelsVisible;
    }

    toggleEdgeLabels(): void {
        this.styleService.edgeLabelsVisible = !this.styleService.edgeLabelsVisible;
        this.visualiser?.restoreLabels();
    }

    get degreeScaling(): boolean {
        return this.styleService.degreeScaling;
    }

    toggleDegreeScaling(): void {
        this.styleService.degreeScaling = !this.styleService.degreeScaling;
        if (this.styleService.degreeScaling) {
            this.visualiser?.applyStructureMode();
        } else {
            this.visualiser?.applyStyleUpdate();
        }
    }

    get colorEdgesByConstraint(): boolean {
        return this.styleService.colorEdgesByConstraint;
    }

    toggleEdgeColoring(): void {
        this.styleService.colorEdgesByConstraint = !this.styleService.colorEdgesByConstraint;
        this.visualiser?.colorEdgesByConstraintIndex(!this.styleService.colorEdgesByConstraint);
    }

    get edgesCurvedByDefault(): boolean {
        return this.styleService.edgesCurvedByDefault;
    }

    toggleEdgesCurved(): void {
        this.styleService.edgesCurvedByDefault = !this.styleService.edgesCurvedByDefault;
        this.visualiser?.applyEdgeCurvature();
    }

    setBackgroundColor1(color1: string): void {
        this.styleService.updateBackground({ color1 });
    }

    setBackgroundColor2(color2: string): void {
        this.styleService.updateBackground({ color2 });
    }

    setBackgroundAngle(gradientAngle: number): void {
        this.styleService.updateBackground({ gradientAngle });
    }

    get hasBackgroundOverride(): boolean {
        return this.styleService.background.type !== "default";
    }

    resetBackground(): void {
        this.styleService.background = { ...DEFAULT_BACKGROUND };
    }

    private applyStyles(): void {
        this.visualiser?.applyStyleUpdate();
    }
}
