import { initialThemePair, shareThemeStructure } from "../framework/util/graph-theme-pair";
import { inheritedEdgeStyle } from "../framework/util/graph-edge";
import type { SchemaDefaults } from "../framework/util/schema-meta";
import type { LineStyle } from "../framework/util/line-style";
import { Injectable, OnDestroy } from "@angular/core";
import { BehaviorSubject, Subscription } from "rxjs";
import chroma from "chroma-js";
import { VertexKind } from "@typedb/graph-utils";
import { GraphStyles, defaultEdgeLabelColors, defaultQueryStyleParams, calAestheticsKindStyles } from "../framework/graph-visualiser/engine/styles";
import { ThemeService } from "./theme.service";
import { exportGraphPresets, mergeGraphPresets, parseGraphPresets } from "../framework/util/graph-presets";

export interface NodeStyle {
    lineStyle: LineStyle;
    lineThickness: number;
    color: string;
    fillColor: string;
    shape: string;
    width: number;
    height: number;
}

export type PartialNodeStyle = Partial<Pick<NodeStyle, "color" | "shape" | "width" | "height" | "lineStyle" | "lineThickness">>;

const STORAGE_KEY = "typedb-studio-graph-styles";
const CUSTOM_PRESETS_KEY = "typedb-studio-custom-presets";

export type GraphBackgroundType = "default" | "solid" | "gradient" | "grid" | "dots" | "party";

export interface GraphBackground {
    type: GraphBackgroundType;
    color1: string;
    color2: string;
    gradientAngle: number;
    /** When true, the base colour follows the app theme (`--theme-black`)
     *  instead of the fixed `color1` — so a patterned background (e.g. the dots
     *  used by Cal Aesthetics) still flips light/dark with the theme, the same
     *  way `type: "default"` does. */
    themed?: boolean;
}

export const DEFAULT_BACKGROUND: GraphBackground = {
    type: "default",
    color1: "#0e0e0e",
    color2: "#1A182A",
    gradientAngle: 180,
};

export interface BackgroundCSS {
    color: string;
    image: string;
    size: string;
}

export function buildBackgroundCSS(bg: GraphBackground): BackgroundCSS {
    // Theme-adaptive base: follows the app theme like `type: "default"` does.
    const base = bg.themed ? "var(--theme-black)" : bg.color1;
    switch (bg.type) {
        case "default":
            return { color: "var(--theme-black)", image: "none", size: "" };
        case "solid":
            return { color: base, image: "none", size: "" };
        case "gradient":
            return { color: base, image: `linear-gradient(${bg.gradientAngle}deg, ${base}, ${bg.color2})`, size: "" };
        case "grid":
            return {
                color: base,
                image: `repeating-linear-gradient(0deg, transparent, transparent 29px, ${bg.color2} 29px, ${bg.color2} 30px), repeating-linear-gradient(90deg, transparent, transparent 29px, ${bg.color2} 29px, ${bg.color2} 30px)`,
                size: "",
            };
        case "dots":
            return { color: base, image: `radial-gradient(${bg.color2} 1px, transparent 1px)`, size: "20px 20px" };
        case "party":
            return { color: base, image: "none", size: "" };
        default:
            return { color: base, image: "none", size: "" };
    }
}

/** Which edge of the graph canvas the side panel docks to. */
export type GraphSidePanelDock = "bottom" | "right";

export interface CustomPreset {
    name: string;
    description: string;
    kindStyles: Record<string, PartialNodeStyle>;
    typeStyles: Record<string, PartialNodeStyle>;
    edgeLabelColors: Record<string, string>;
    roleArrows?: Record<string, "none" | "relation" | "player">;
    edgeLineStyles?: Record<string, LineStyle>;
    defaultEdgeLineStyle?: LineStyle;
    edgeLineThicknesses?: Record<string, number>;
    defaultEdgeLineThickness?: number;
    /** Optional: colour for edges without a per-label override. */
    defaultEdgeColor?: string | null;
    colorEdgesByConstraint: boolean;
    labelColorMode?: "auto" | "border" | "fixed";
    labelUseBorderColor?: boolean; // legacy, for backwards compat
    labelsVisible: boolean;
    /** Optional (back-compat): edge label visibility, independent of node labels. */
    edgeLabelsVisible?: boolean;
    showHoverLabel: boolean;
    degreeScaling: boolean;
    /** Optional: edges curved by default. */
    edgesCurvedByDefault?: boolean;
    /** Optional: node fill opacity (0–1). */
    fillOpacity?: number;
    background: GraphBackground;
}

function parseHex(hex: string): [number, number, number] {
    const h = hex.startsWith("#") ? hex.slice(1) : hex;
    return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
}

function blendColors(foreHex: string, bgHex: string, amount: number): string {
    const [fr, fg, fb] = parseHex(foreHex);
    const [br, bg, bb] = parseHex(bgHex);
    const r = Math.round(fr * amount + br * (1 - amount));
    const g = Math.round(fg * amount + bg * (1 - amount));
    const b = Math.round(fb * amount + bb * (1 - amount));
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Migrate saved styles from the old borderColor+color model to the single color model. */
function migrateStyles(styles: Record<string, any>): Record<string, PartialNodeStyle> {
    const result: Record<string, PartialNodeStyle> = {};
    for (const [key, val] of Object.entries(styles)) {
        const { borderColor, color, ...rest } = val as any;
        result[key] = { ...rest, color: borderColor ?? color };
    }
    return result;
}

const ALL_KINDS: VertexKind[] = [
    "entity", "relation", "attribute",
    "entityType", "relationType", "attributeType", "roleType",
    "value", "unavailable",
];

@Injectable({ providedIn: "root" })
export class GraphStyleService implements OnDestroy {

    private _kindStyles: Record<string, PartialNodeStyle> = {};
    private _typeStyles: Record<string, PartialNodeStyle> = {};
    private _edgeLabelColors: Record<string, string> = {};
    private _roleArrows: Record<string, "none" | "relation" | "player"> = {};
    /** Role edges are stored relation → player and read "the relation's <role>
     *  is → that player", so arrows point at the player unless a role (or the
     *  links row, for all roles) says otherwise. Role → links → player. */
    getRoleArrow(role: string): "none" | "relation" | "player" { return this._roleArrows[role] ?? this.inheritedRoleArrow(role); }
    /** What a role shows without its own override: the schema's
     *  `@meta("graph-arrow", …)` on the role or relation, then links, then player. */
    inheritedRoleArrow(role: string): "none" | "relation" | "player" {
        return (role !== "links" ? this._schemaDefaults?.arrow(role) : undefined) ?? this._roleArrows["links"] ?? "player";
    }
    schemaRoleArrow(role: string): "none" | "relation" | "player" | undefined { return this._schemaDefaults?.arrow(role); }

    private _schemaDefaults: SchemaDefaults | null = null;
    /** Bumped whenever label inputs change (schema defaults, value length),
     *  so visualisers re-derive node labels on the next styles$ emission. */
    labelRevision = 0;
    get schemaDefaults(): SchemaDefaults | null { return this._schemaDefaults; }
    setSchemaDefaults(defaults: SchemaDefaults | null): void {
        this._schemaDefaults = defaults;
        this.labelRevision++;
        this.styles$.next();
    }
    private _labelValueScale = 0.8;
    /** Size of value lines relative to the type line in node labels. */
    get labelValueScale(): number { return this._labelValueScale; }
    set labelValueScale(value: number) {
        this._labelValueScale = Math.max(0.5, Math.min(1, value || 0.8));
        this.save(); this.styles$.next();
    }
    private _arrowHeadScale = 1;
    /** Multiplies the size of isa / role arrowheads (0.25–3). */
    get arrowHeadScale(): number { return this._arrowHeadScale; }
    set arrowHeadScale(value: number) {
        this._arrowHeadScale = Math.max(0.25, Math.min(3, value || 1));
        this.save(); this.styles$.next();
    }
    private _labelValueLength = 40;
    /** Longest value fragment shown in a node label; 0 shows full values. */
    get labelValueLength(): number { return this._labelValueLength; }
    set labelValueLength(value: number) {
        this._labelValueLength = Math.max(0, Math.round(value || 0));
        this.labelRevision++;
        this.save(); this.styles$.next();
    }
    hasRoleArrow(role: string): boolean { return Object.hasOwn(this._roleArrows, role); }
    /** Null returns the role to its inherited direction; "none" is an explicit opt-out. */
    setRoleArrow(role: string, direction: "none" | "relation" | "player" | null): void {
        if (direction === null) delete this._roleArrows[role]; else this._roleArrows[role] = direction;
        this.save(); this.styles$.next();
    }
    private _edgeLineStyles: Record<string, LineStyle> = {};
    private _defaultEdgeLineStyle: LineStyle = "solid";
    private _edgeLineThicknesses: Record<string, number> = {};
    private _defaultEdgeLineThickness = 1;
    /** User override for the colour of every edge that has no per-label colour
     *  of its own. Null → fall back to the built-in default edge colour. */
    private _defaultEdgeColor: string | null = null;
    private _colorEdgesByConstraint = false;
    private _labelColorMode: "auto" | "border" | "fixed" = "auto";
    private _highlightedKinds = new Set<VertexKind>();
    private _highlightedTypes = new Set<string>();
    private _highlightedEdges = new Set<string>();

    /** Transient preview state set by hovering a highlight chip when no real highlights/selection are active.
     *  Drives a softer fade in the visualiser's reducers — see `setPreview*` / `clearPreview` below. */
    private _previewedKind: VertexKind | null = null;
    private _previewedType: string | null = null;
    private _previewedEdge: string | null = null;
    private _activePreset: string | null = null;
    private _labelsVisible = true;
    private _edgeLabelsVisible = true;
    private _showHoverLabel = true;
    private _degreeScaling = false;
    private _edgesCurvedByDefault = false;
    private _fillOpacity = 0.25;
    private _sidePanelDock: GraphSidePanelDock = "right";
    private _background: GraphBackground = { ...DEFAULT_BACKGROUND };

    private _customPresets: CustomPreset[] = [];

    readonly styles$ = new BehaviorSubject<void>(undefined);
    private themeSubscription: Subscription;
    private onPairStorage = (event: StorageEvent): void => {
        if (event.key !== "typedb-studio-theme-pair-v1" || !event.newValue) return;
        try {
            const pair = JSON.parse(event.newValue);
            this.themePair = { light: parseGraphPresets(JSON.stringify(pair.light))[0], dark: parseGraphPresets(JSON.stringify(pair.dark))[0] };
            this.applyCapturedPreset(this.themePair[this.paletteMode]);
        } catch { /* Ignore invalid external storage. */ }
    };
    private themePair!: Record<"light" | "dark", CustomPreset>;
    private paletteMode: "light" | "dark" = "dark";
    get currentPalette(): "light" | "dark" { return this.paletteMode; }
    choosePalette(mode: "light" | "dark"): void { this.themeService.setPreference(mode); }
    exportThemePair(): string { return exportGraphPresets([this.themePair.light, this.themePair.dark]); }
    private saveThemePair(): void {
        if (!this.themePair) return;
        const other = this.paletteMode === "light" ? "dark" : "light";
        this.themePair[this.paletteMode] = this.capturePreset(this.themePair[this.paletteMode].name);
        this.themePair[other] = shareThemeStructure(this.themePair[this.paletteMode], this.themePair[other]);
        localStorage.setItem("typedb-studio-theme-pair-v1", JSON.stringify(this.themePair));
    }

    constructor(private themeService: ThemeService) {
        this.load();
        this.loadCustomPresets();
        this.paletteMode = this.themeService.effectiveTheme$.value;
        try {
            const saved = JSON.parse(localStorage.getItem("typedb-studio-theme-pair-v1") ?? "null");
            if (saved) this.themePair = { light: parseGraphPresets(JSON.stringify(saved.light))[0], dark: parseGraphPresets(JSON.stringify(saved.dark))[0] };
        } catch { /* Fall back to the supplied pair without deleting old presets. */ }
        if (!this.themePair) {
            if (localStorage.getItem(STORAGE_KEY)) this.saveCustomPreset("Before paired themes " + new Date().toISOString(), "Preserved before light/dark pairing");
            this.themePair = structuredClone(initialThemePair);
            this.themePair.dark = shareThemeStructure(this.themePair.light, this.themePair.dark);
        }
        this.applyCapturedPreset(this.themePair[this.paletteMode]);
        this.saveThemePair();
        window.addEventListener("storage", this.onPairStorage);
        this.themeSubscription = this.themeService.effectiveTheme$.subscribe(mode => {
            if (mode !== this.paletteMode) {
                this.saveThemePair(); this.paletteMode = mode;
                this.applyCapturedPreset(this.themePair[mode]);
            }
            this.styles$.next();
        });
    }

    ngOnDestroy() {
        window.removeEventListener("storage", this.onPairStorage);
        this.themeSubscription.unsubscribe();
    }

    get effectiveBackgroundHex(): string {
        const bg = this._background;
        if (bg.type === "default" || bg.themed) {
            return getComputedStyle(document.documentElement).getPropertyValue("--theme-black").trim();
        }
        return bg.color1; // solid, gradient, grid, dots, party — color1 is always the base
    }

    private deriveFill(color: string): string {
        return blendColors(color, this.effectiveBackgroundHex, this._fillOpacity);
    }

    getKindDefault(kind: VertexKind): NodeStyle {
        const color = defaultQueryStyleParams.vertexBorderColors[kind];
        return {
            color,
            fillColor: this.deriveFill(color),
            lineStyle: "solid",
            lineThickness: 1,
            shape: defaultQueryStyleParams.vertexShapes[kind],
            width: defaultQueryStyleParams.vertexWidths[kind],
            height: defaultQueryStyleParams.vertexHeights[kind],
        };
    }

    getKindStyle(kind: VertexKind): NodeStyle {
        const base = this.getKindDefault(kind);
        const override = this._kindStyles[kind];
        const color = override?.color ?? base.color;
        return {
            color,
            fillColor: this.deriveFill(color),
            lineStyle: override?.lineStyle ?? base.lineStyle,
            lineThickness: override?.lineThickness ?? base.lineThickness,
            shape: override?.shape ?? base.shape,
            width: override?.width ?? base.width,
            height: override?.height ?? base.height,
        };
    }

    resolveNodeStyle(kind: VertexKind, typeLabel?: string): NodeStyle {
        const kindStyle = this.getKindStyle(kind);
        if (!typeLabel) return kindStyle;

        const typeOverride = this._typeStyles[typeLabel];
        if (!typeOverride) return kindStyle;

        const color = typeOverride.color ?? kindStyle.color;
        return {
            color,
            fillColor: this.deriveFill(color),
            lineStyle: typeOverride.lineStyle ?? kindStyle.lineStyle,
            lineThickness: typeOverride.lineThickness ?? kindStyle.lineThickness,
            shape: typeOverride.shape ?? kindStyle.shape,
            width: typeOverride.width ?? kindStyle.width,
            height: typeOverride.height ?? kindStyle.height,
        };
    }

    setKindStyle(kind: VertexKind, style: PartialNodeStyle): void {
        this._kindStyles[kind] = { ...this._kindStyles[kind], ...style };
        this.save();
        this.styles$.next();
    }

    setTypeStyle(typeLabel: string, style: PartialNodeStyle): void {
        this._typeStyles[typeLabel] = { ...this._typeStyles[typeLabel], ...style };
        this.save();
        this.styles$.next();
    }

    removeKindStyle(kind: VertexKind): void {
        delete this._kindStyles[kind];
        this.save();
        this.styles$.next();
    }

    hasKindOverride(kind: VertexKind): boolean {
        const override = this._kindStyles[kind];
        return !!override && Object.keys(override).length > 0;
    }

    removeTypeStyle(typeLabel: string): void {
        delete this._typeStyles[typeLabel];
        this.save();
        this.styles$.next();
    }

    get kindStyles(): Record<string, PartialNodeStyle> {
        return this._kindStyles;
    }

    get typeStyles(): Record<string, PartialNodeStyle> {
        return this._typeStyles;
    }

    get colorEdgesByConstraint(): boolean {
        return this._colorEdgesByConstraint;
    }

    set colorEdgesByConstraint(value: boolean) {
        this._colorEdgesByConstraint = value;
        this.save();
    }

    get labelColorMode(): "auto" | "border" | "fixed" {
        return this._labelColorMode;
    }

    set labelColorMode(value: "auto" | "border" | "fixed") {
        this._labelColorMode = value;
        this.save();
        this.styles$.next();
    }

    /** Resolves "auto" to the effective mode based on background luminance. */
    get labelUseBorderColor(): boolean {
        if (this._labelColorMode === "auto") {
            const hex = this.effectiveBackgroundHex;
            const h = hex.startsWith("#") ? hex.slice(1) : hex;
            const r = parseInt(h.substring(0, 2), 16);
            const g = parseInt(h.substring(2, 4), 16);
            const b = parseInt(h.substring(4, 6), 16);
            const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            return luminance < 0.5; // dark bg → border color; light bg → fixed
        }
        return this._labelColorMode === "border";
    }

    getNodeLineStyle(kind: string, typeLabel?: string): LineStyle {
        return (typeLabel ? this._typeStyles[typeLabel]?.lineStyle : undefined) ?? this._kindStyles[kind]?.lineStyle ?? "solid";
    }
    clearTypeLineStyle(typeLabel: string): void {
        if (this._typeStyles[typeLabel]) {
            delete this._typeStyles[typeLabel].lineStyle;
            if (!Object.keys(this._typeStyles[typeLabel]).length) delete this._typeStyles[typeLabel];
        }
        this.save(); this.styles$.next();
    }

    getEdgeLineStyle(tag?: string): LineStyle { return inheritedEdgeStyle(this._edgeLineStyles, tag, this._defaultEdgeLineStyle); }
    hasEdgeLineStyle(tag: string): boolean { return this._edgeLineStyles[tag] !== undefined; }
    setEdgeLineStyle(style: LineStyle | null, tag?: string): void {
        if (!tag) this._defaultEdgeLineStyle = style ?? "solid";
        else if (style === null) delete this._edgeLineStyles[tag];
        else this._edgeLineStyles[tag] = style;
        this.save(); this.styles$.next();
    }

    /** Relative to the established outline/edge width; 1 preserves old presets. */
    getNodeLineThickness(kind: string, typeLabel?: string): number {
        return (typeLabel ? this._typeStyles[typeLabel]?.lineThickness : undefined) ?? this._kindStyles[kind]?.lineThickness ?? 1;
    }
    setNodeLineThickness(value: number | null, kind: VertexKind, typeLabel?: string): void {
        if (value !== null && (!Number.isFinite(value) || value < 0.25 || value > 8)) return;
        const styles = typeLabel ? this._typeStyles : this._kindStyles, key = typeLabel ?? kind;
        if (value === null) {
            if (styles[key]) {
                delete styles[key].lineThickness;
                if (!Object.keys(styles[key]).length) delete styles[key];
            }
        } else styles[key] = { ...styles[key], lineThickness: value };
        this.save(); this.styles$.next();
    }
    getEdgeLineThickness(tag?: string): number { return inheritedEdgeStyle(this._edgeLineThicknesses, tag, this._defaultEdgeLineThickness); }
    hasEdgeLineThickness(tag: string): boolean { return this._edgeLineThicknesses[tag] !== undefined; }
    setEdgeLineThickness(value: number | null, tag?: string): void {
        if (value !== null && (!Number.isFinite(value) || value < 0.25 || value > 8)) return;
        if (!tag) this._defaultEdgeLineThickness = value ?? 1;
        else if (value === null) delete this._edgeLineThicknesses[tag];
        else this._edgeLineThicknesses[tag] = value;
        this.save(); this.styles$.next();
    }

    // -- Edge label colors --

    getEdgeLabelColor(tag: string): string {
        return inheritedEdgeStyle(this._edgeLabelColors, tag, inheritedEdgeStyle(defaultEdgeLabelColors, tag, this.defaultEdgeColor));
    }

    /** Colour used for any edge without its own per-label override. */
    get defaultEdgeColor(): string {
        return this._defaultEdgeColor ?? defaultQueryStyleParams.edgeColor.hex();
    }

    set defaultEdgeColor(color: string) {
        this._defaultEdgeColor = color;
        this.save();
        this.styles$.next();
    }

    get hasDefaultEdgeColorOverride(): boolean {
        return this._defaultEdgeColor != null;
    }

    clearDefaultEdgeColor(): void {
        this._defaultEdgeColor = null;
        this.save();
        this.styles$.next();
    }

    setEdgeLabelColor(tag: string, color: string): void {
        this._edgeLabelColors[tag] = color;
        this.save();
        this.styles$.next();
    }

    removeEdgeLabelColor(tag: string): void {
        delete this._edgeLabelColors[tag];
        this.save();
        this.styles$.next();
    }

    get edgeLabelColors(): Record<string, string> {
        return this._edgeLabelColors;
    }

    getResolvedEdgeLabelColors(): Record<string, string> {
        return { ...defaultEdgeLabelColors, ...this._edgeLabelColors };
    }

    toGraphStyles(): GraphStyles {
        const vertexColors: Record<string, string> = {} as any;
        const vertexBorderColors: Record<string, string> = {} as any;
        const vertexShapes: Record<string, string> = {} as any;
        const vertexWidths: Record<string, number> = {} as any;
        const vertexHeights: Record<string, number> = {} as any;
        for (const kind of ALL_KINDS) {
            const style = this.getKindStyle(kind);
            vertexColors[kind] = style.fillColor;
            vertexBorderColors[kind] = style.color;
            vertexShapes[kind] = style.shape;
            vertexWidths[kind] = style.width;
            vertexHeights[kind] = style.height;
        }

        const vertexTypeColors: Record<string, string> = {};
        const vertexTypeBorderColors: Record<string, string> = {};
        const vertexTypeShapes: Record<string, string> = {};
        const vertexTypeWidths: Record<string, number> = {};
        const vertexTypeHeights: Record<string, number> = {};
        for (const [typeLabel, override] of Object.entries(this._typeStyles)) {
            const color = override.color;
            if (color) {
                vertexTypeBorderColors[typeLabel] = color;
                vertexTypeColors[typeLabel] = this.deriveFill(color);
            }
            if (override.shape) vertexTypeShapes[typeLabel] = override.shape;
            if (override.width) vertexTypeWidths[typeLabel] = override.width;
            if (override.height) vertexTypeHeights[typeLabel] = override.height;
        }

        return {
            ...defaultQueryStyleParams,
            vertexColors: vertexColors as any,
            vertexBorderColors: vertexBorderColors as any,
            vertexShapes: vertexShapes as any,
            vertexWidths: vertexWidths as any,
            vertexHeights: vertexHeights as any,
            vertexTypeColors: Object.keys(vertexTypeColors).length ? vertexTypeColors : undefined,
            vertexTypeBorderColors: Object.keys(vertexTypeBorderColors).length ? vertexTypeBorderColors : undefined,
            vertexTypeShapes: Object.keys(vertexTypeShapes).length ? vertexTypeShapes : undefined,
            vertexTypeWidths: Object.keys(vertexTypeWidths).length ? vertexTypeWidths : undefined,
            vertexTypeHeights: Object.keys(vertexTypeHeights).length ? vertexTypeHeights : undefined,
            edgeColor: chroma(this.defaultEdgeColor),
            edgesCurvedByDefault: this._edgesCurvedByDefault,
            edgeLabelColors: this.getResolvedEdgeLabelColors(),
        };
    }

    // -- Highlights --

    get highlightedKinds(): Set<VertexKind> { return this._highlightedKinds; }
    get highlightedTypes(): Set<string> { return this._highlightedTypes; }
    get highlightedEdges(): Set<string> { return this._highlightedEdges; }

    isHighlightActive(): boolean {
        return this._highlightedKinds.size > 0 || this._highlightedTypes.size > 0 || this._highlightedEdges.size > 0;
    }

    toggleHighlightKind(kind: VertexKind): void {
        if (this._highlightedKinds.has(kind)) this._highlightedKinds.delete(kind);
        else this._highlightedKinds.add(kind);
        this.styles$.next();
    }

    toggleHighlightType(typeLabel: string): void {
        if (this._highlightedTypes.has(typeLabel)) this._highlightedTypes.delete(typeLabel);
        else this._highlightedTypes.add(typeLabel);
        this.styles$.next();
    }

    toggleHighlightEdge(tag: string): void {
        if (this._highlightedEdges.has(tag)) this._highlightedEdges.delete(tag);
        else this._highlightedEdges.add(tag);
        this.styles$.next();
    }

    clearHighlights(): void {
        this._highlightedKinds.clear();
        this._highlightedTypes.clear();
        this._highlightedEdges.clear();
        this.styles$.next();
    }

    shouldHighlightNode(kind: VertexKind, typeLabel?: string): boolean {
        if (this._highlightedKinds.size === 0 && this._highlightedTypes.size === 0) return true;
        if (this._highlightedKinds.has(kind)) return true;
        if (typeLabel && this._highlightedTypes.has(typeLabel)) return true;
        return false;
    }

    shouldHighlightEdge(tag: string): boolean {
        if (this._highlightedEdges.size === 0) return true;
        if (this._highlightedEdges.has(tag)) return true;
        return false;
    }

    // -- Hover preview (subtle fade triggered by hovering a highlight chip) --

    get previewedKind(): VertexKind | null { return this._previewedKind; }
    get previewedType(): string | null { return this._previewedType; }
    get previewedEdge(): string | null { return this._previewedEdge; }

    isPreviewActive(): boolean {
        return this._previewedKind !== null || this._previewedType !== null || this._previewedEdge !== null;
    }

    setPreviewKind(kind: VertexKind): void {
        this._previewedKind = kind;
        this._previewedType = null;
        this._previewedEdge = null;
    }

    setPreviewType(typeLabel: string): void {
        this._previewedKind = null;
        this._previewedType = typeLabel;
        this._previewedEdge = null;
    }

    setPreviewEdge(tag: string): void {
        this._previewedKind = null;
        this._previewedType = null;
        this._previewedEdge = tag;
    }

    clearPreview(): void {
        this._previewedKind = null;
        this._previewedType = null;
        this._previewedEdge = null;
    }

    /** Whether a node should be drawn at full strength under the current preview state.
     *  Returns true when no node-targeting preview is active (e.g. only an edge chip is hovered). */
    shouldPreviewNode(kind: VertexKind, typeLabel?: string): boolean {
        if (this._previewedKind === null && this._previewedType === null) return true;
        if (this._previewedKind === kind) return true;
        if (typeLabel && this._previewedType === typeLabel) return true;
        return false;
    }

    /** Whether an edge should be drawn at full strength under the current preview state.
     *  Returns true when no edge-targeting preview is active. */
    shouldPreviewEdge(tag: string): boolean {
        if (this._previewedEdge === null) return true;
        if (this._previewedEdge === tag) return true;
        return false;
    }

    // -- Presets --

    get activePreset(): string | null { return this._activePreset; }

    set activePreset(value: string | null) {
        this._activePreset = value;
        this.save();
    }

    get background(): GraphBackground { return this._background; }

    set background(value: GraphBackground) {
        this._background = value;
        this.save();
        this.styles$.next();
    }

    updateBackground(partial: Partial<GraphBackground>): void {
        // A manual background change (type/colour/angle from the UI) is a fixed
        // choice, so clear the theme-adaptive flag unless the caller re-asserts
        // it. Presets that want a themed base set `_background` directly.
        this._background = { ...this._background, themed: false, ...partial };
        this.save();
        this.styles$.next();
    }

    get fillOpacity(): number { return this._fillOpacity; }

    set fillOpacity(value: number) {
        this._fillOpacity = Math.max(0, Math.min(1, value));
        this.save();
        this.styles$.next();
    }

    get sidePanelDock(): GraphSidePanelDock { return this._sidePanelDock; }

    set sidePanelDock(value: GraphSidePanelDock) {
        this._sidePanelDock = value;
        this.save();
        this.styles$.next();
    }

    get degreeScaling(): boolean { return this._degreeScaling; }

    set degreeScaling(value: boolean) {
        this._degreeScaling = value;
        this.save();
        this.styles$.next();
    }

    /** When true, edges are drawn curved by default (parallel edges fan out);
     *  when false, single edges are straight. */
    get edgesCurvedByDefault(): boolean { return this._edgesCurvedByDefault; }

    set edgesCurvedByDefault(value: boolean) {
        this._edgesCurvedByDefault = value;
        this.save();
        this.styles$.next();
    }

    get labelsVisible(): boolean { return this._labelsVisible; }

    set labelsVisible(value: boolean) {
        this._labelsVisible = value;
        this.save();
        this.styles$.next();
    }

    get edgeLabelsVisible(): boolean { return this._edgeLabelsVisible; }

    set edgeLabelsVisible(value: boolean) {
        this._edgeLabelsVisible = value;
        this.save();
        this.styles$.next();
    }

    get showHoverLabel(): boolean { return this._showHoverLabel; }

    set showHoverLabel(value: boolean) {
        this._showHoverLabel = value;
        this.save();
        this.styles$.next();
    }

    applyStructurePreset(): void {
        for (const kind of ALL_KINDS) {
            const color = defaultQueryStyleParams.vertexBorderColors[kind];
            this._kindStyles[kind] = { color, shape: "ellipse", width: 6, height: 6 };
        }
        this._labelColorMode = "auto";
        this._labelsVisible = false;
        this._showHoverLabel = true;
        this._degreeScaling = true;
        this._edgesCurvedByDefault = false;
        this._activePreset = "structure";
        this.save();
        this.styles$.next();
    }

    applyUniformPreset(): void {
        for (const kind of ALL_KINDS) {
            const color = defaultQueryStyleParams.vertexBorderColors[kind];
            this._kindStyles[kind] = { color, shape: "rounded-rect", width: 56, height: 24 };
        }
        this._labelColorMode = "auto";
        this._labelsVisible = true;
        this._showHoverLabel = true;
        this._degreeScaling = false;
        this._edgesCurvedByDefault = false;
        this._activePreset = "uniform";
        this.save();
        this.styles$.next();
    }

    applyClassicPreset(): void {
        for (const kind of ALL_KINDS) {
            const color = defaultQueryStyleParams.vertexBorderColors[kind];
            const shape = defaultQueryStyleParams.vertexShapes[kind];
            const width = defaultQueryStyleParams.vertexWidths[kind];
            const height = defaultQueryStyleParams.vertexHeights[kind];
            this._kindStyles[kind] = { color, shape, width, height };
        }
        this._labelColorMode = "fixed";
        this._labelsVisible = true;
        this._showHoverLabel = true;
        this._degreeScaling = false;
        this._edgesCurvedByDefault = false;
        this._activePreset = "classic";
        this.save();
        this.styles$.next();
    }

    applyGrayscalePreset(): void {
        const grays: Record<string, string> = {
            entity: "#d6d6d6",
            relation: "#b8b8b8",
            attribute: "#8a8a8a",
            entityType: "#d6d6d6",
            relationType: "#b8b8b8",
            attributeType: "#8a8a8a",
            roleType: "#4a4a4a",
            value: "#4a4a4a",
            unavailable: "#404040",
        };
        for (const kind of ALL_KINDS) {
            const color = grays[kind] ?? "#5e5e5e";
            const shape = defaultQueryStyleParams.vertexShapes[kind];
            const width = defaultQueryStyleParams.vertexWidths[kind];
            const height = defaultQueryStyleParams.vertexHeights[kind];
            this._kindStyles[kind] = { color, shape, width, height };
        }
        this._labelColorMode = "fixed";
        this._labelsVisible = true;
        this._showHoverLabel = true;
        this._degreeScaling = false;
        this._edgesCurvedByDefault = false;
        this._activePreset = "grayscale";
        this.save();
        this.styles$.next();
    }

    applyCalAestheticsPreset(): void {
        for (const kind of ALL_KINDS) {
            const s = calAestheticsKindStyles[kind];
            if (s) {
                this._kindStyles[kind] = { color: s.color, shape: s.shape, width: s.width, height: s.height };
            } else {
                const color = defaultQueryStyleParams.vertexBorderColors[kind];
                this._kindStyles[kind] = { color, shape: "ellipse", width: 56, height: 24 };
            }
        }
        this._labelColorMode = "auto";
        this._labelsVisible = true;
        this._showHoverLabel = true;
        this._degreeScaling = false;
        this._edgesCurvedByDefault = true;
        this._fillOpacity = 0.1;
        // Dots pattern, but with a theme-adaptive base so it flips light/dark
        // with the app theme (the dot colour reads on both).
        this._background = { type: "dots", themed: true, color1: "#0e0e0e", color2: "#3a3848", gradientAngle: DEFAULT_BACKGROUND.gradientAngle };
        this._activePreset = "cal";
        this.save();
        this.styles$.next();
    }

    applyDefaultPreset(): void {
        this.resetToDefaults();
        this._labelsVisible = true;
        this._activePreset = "default";
        this.save();
        this.styles$.next();
    }

    resetToDefaults(): void {
        this._roleArrows = {};
        this._kindStyles = {};
        this._typeStyles = {};
        this._edgeLabelColors = {};
        this._edgeLineStyles = {};
        this._defaultEdgeLineStyle = "solid";
        this._edgeLineThicknesses = {};
        this._defaultEdgeLineThickness = 1;
        this._defaultEdgeColor = null;
        this._labelColorMode = "auto";
        this._colorEdgesByConstraint = false;
        this._labelsVisible = true;
        this._edgeLabelsVisible = true;
        this._showHoverLabel = true;
        this._degreeScaling = false;
        this._edgesCurvedByDefault = false;
        // Default matches the field initializer and the persisted-state
        // fallback below — without this line the customise slider stayed
        // wherever the user last left it after Reset all.
        this._fillOpacity = 0.25;
        this._background = { ...DEFAULT_BACKGROUND };
        this._activePreset = null;
        this.save();
        this.styles$.next();
    }

    // -- Custom presets --

    get customPresets(): readonly CustomPreset[] {
        return this._customPresets;
    }

    exportPresets(name?: string): string {
        return exportGraphPresets(name ? this._customPresets.filter(p => p.name === name) : this._customPresets);
    }

    importPresets(text: string): number {
        const incoming = parseGraphPresets(text);
        const merged = mergeGraphPresets(this._customPresets, incoming);
        // Write first so a storage failure leaves the in-memory collection unchanged too.
        localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(merged));
        this._customPresets = merged;
        return incoming.length;
    }

    capturePreset(name = "Snapshot", description = "Saved graph appearance"): CustomPreset {
        return {
            name,
            description,
            kindStyles: structuredClone(this._kindStyles),
            typeStyles: structuredClone(this._typeStyles),
            edgeLabelColors: { ...this._edgeLabelColors },
            roleArrows: { ...this._roleArrows },
            edgeLineStyles: { ...this._edgeLineStyles },
            defaultEdgeLineStyle: this._defaultEdgeLineStyle,
            edgeLineThicknesses: { ...this._edgeLineThicknesses },
            defaultEdgeLineThickness: this._defaultEdgeLineThickness,
            defaultEdgeColor: this._defaultEdgeColor,
            colorEdgesByConstraint: this._colorEdgesByConstraint,
            labelColorMode: this._labelColorMode,
            labelsVisible: this._labelsVisible,
            edgeLabelsVisible: this._edgeLabelsVisible,
            showHoverLabel: this._showHoverLabel,
            degreeScaling: this._degreeScaling,
            edgesCurvedByDefault: this._edgesCurvedByDefault,
            fillOpacity: this._fillOpacity,
            background: { ...this._background },
        };
    }

    saveCustomPreset(name: string, description: string): void {
        const preset = this.capturePreset(name, description);
        const idx = this._customPresets.findIndex(p => p.name === name);
        if (idx >= 0) {
            this._customPresets[idx] = preset;
        } else {
            this._customPresets.push(preset);
        }
        this.saveCustomPresets();
    }

    applyCustomPreset(name: string): void {
        const preset = this._customPresets.find(p => p.name === name);
        if (!preset) return;
        this.applyCapturedPreset(preset, true);
    }

    applyCapturedPreset(preset: CustomPreset, persist = false): void {
        this._kindStyles = structuredClone(preset.kindStyles);
        this._typeStyles = structuredClone(preset.typeStyles);
        this._edgeLabelColors = { ...preset.edgeLabelColors };
        this._roleArrows = { ...preset.roleArrows };
        this._edgeLineStyles = { ...preset.edgeLineStyles };
        this._defaultEdgeLineStyle = preset.defaultEdgeLineStyle ?? "solid";
        this._edgeLineThicknesses = { ...preset.edgeLineThicknesses };
        this._defaultEdgeLineThickness = preset.defaultEdgeLineThickness ?? 1;
        this._defaultEdgeColor = preset.defaultEdgeColor ?? null;
        this._colorEdgesByConstraint = preset.colorEdgesByConstraint;
        this._labelColorMode = preset.labelColorMode ?? (preset.labelUseBorderColor ? "auto" : "fixed");
        this._labelsVisible = preset.labelsVisible;
        this._edgeLabelsVisible = preset.edgeLabelsVisible ?? true;
        this._showHoverLabel = preset.showHoverLabel;
        this._degreeScaling = preset.degreeScaling;
        this._edgesCurvedByDefault = preset.edgesCurvedByDefault ?? false;
        if (preset.fillOpacity != null) this._fillOpacity = preset.fillOpacity;
        this._background = { ...preset.background };
        this._activePreset = `custom:${preset.name}`;
        if (persist) this.save();
        this.styles$.next();
    }

    renameCustomPreset(oldName: string, newName: string, newDescription: string): void {
        const preset = this._customPresets.find(p => p.name === oldName);
        if (!preset) return;
        preset.name = newName;
        preset.description = newDescription;
        if (this._activePreset === `custom:${oldName}`) {
            this._activePreset = `custom:${newName}`;
            this.save();
        }
        this.saveCustomPresets();
        this.styles$.next();
    }

    deleteCustomPreset(name: string): void {
        this._customPresets = this._customPresets.filter(p => p.name !== name);
        if (this._activePreset === `custom:${name}`) {
            this._activePreset = null;
            this.save();
        }
        this.saveCustomPresets();
        this.styles$.next();
    }

    private saveCustomPresets(): void {
        try {
            localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(this._customPresets));
        } catch (e) {
            console.warn("Failed to save custom presets to localStorage:", e);
        }
    }

    private loadCustomPresets(): void {
        try {
            const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
            if (raw) {
                this._customPresets = JSON.parse(raw) ?? [];
            }
        } catch (e) {
            console.warn("Failed to load custom presets from localStorage:", e);
        }
    }

    private save(): void {
        try {
            this.saveThemePair();
            const data = {
                kindStyles: this._kindStyles,
                typeStyles: this._typeStyles,
                edgeLabelColors: this._edgeLabelColors,
                roleArrows: this._roleArrows,
                edgeLineStyles: this._edgeLineStyles,
                defaultEdgeLineStyle: this._defaultEdgeLineStyle,
                edgeLineThicknesses: { ...this._edgeLineThicknesses },
                defaultEdgeLineThickness: this._defaultEdgeLineThickness,
                defaultEdgeColor: this._defaultEdgeColor,
                colorEdgesByConstraint: this._colorEdgesByConstraint,
                labelColorMode: this._labelColorMode,
                activePreset: this._activePreset,
                labelsVisible: this._labelsVisible,
                edgeLabelsVisible: this._edgeLabelsVisible,
                showHoverLabel: this._showHoverLabel,
                degreeScaling: this._degreeScaling,
                edgesCurvedByDefault: this._edgesCurvedByDefault,
                fillOpacity: this._fillOpacity,
                sidePanelDock: this._sidePanelDock,
                background: this._background,
                labelValueLength: this._labelValueLength,
                labelValueScale: this._labelValueScale,
                arrowHeadScale: this._arrowHeadScale,
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn("Failed to save graph styles to localStorage:", e);
        }
    }

    private load(): void {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                this._kindStyles = migrateStyles(data.kindStyles ?? {});
                this._typeStyles = migrateStyles(data.typeStyles ?? {});
                this._edgeLabelColors = data.edgeLabelColors ?? {};
                this._roleArrows = data.roleArrows ?? {};
                this._edgeLineStyles = data.edgeLineStyles ?? {};
                this._defaultEdgeLineStyle = data.defaultEdgeLineStyle ?? "solid";
                this._edgeLineThicknesses = data.edgeLineThicknesses ?? {};
                this._defaultEdgeLineThickness = data.defaultEdgeLineThickness ?? 1;
                this._defaultEdgeColor = data.defaultEdgeColor ?? null;
                this._colorEdgesByConstraint = data.colorEdgesByConstraint ?? false;
                this._labelColorMode = data.labelColorMode ?? (data.labelUseBorderColor === false ? "fixed" : "auto");
                this._activePreset = data.activePreset ?? null;
                this._labelsVisible = data.labelsVisible ?? true;
                this._edgeLabelsVisible = data.edgeLabelsVisible ?? true;
                this._showHoverLabel = data.showHoverLabel ?? true;
                this._degreeScaling = data.degreeScaling ?? false;
                this._edgesCurvedByDefault = data.edgesCurvedByDefault ?? false;
                this._fillOpacity = data.fillOpacity ?? 0.25;
                this._sidePanelDock = data.sidePanelDock ?? "right";
                if (data.background) this._background = { ...DEFAULT_BACKGROUND, ...data.background };
                this._labelValueLength = typeof data.labelValueLength === "number" ? data.labelValueLength : 40;
                this._labelValueScale = typeof data.labelValueScale === "number" ? data.labelValueScale : 0.8;
                this._arrowHeadScale = typeof data.arrowHeadScale === "number" ? data.arrowHeadScale : 1;
            }
        } catch (e) {
            console.warn("Failed to load graph styles from localStorage:", e);
        }
    }
}
