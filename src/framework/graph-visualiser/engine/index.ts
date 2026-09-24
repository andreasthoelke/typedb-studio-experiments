import { edgeDisplayLabel, edgeStyleKey, parallelEdgeGeometry } from "../../util/graph-edge";
import {
    ApiResponse,
    isApiErrorResponse,
    QueryResponse,
} from "@typedb/driver-http";
import type { GraphSnap } from "../../util/graph-snap";
import { GraphElementSelection } from "../../util/graph-element-selection";
import { GraphNavigation, graphDirectionVectors } from "../../util/graph-navigation";
import type { GraphCardinalDirection, GraphDirection, GraphNavigationPoint, GraphSelectionEdit } from "../../util/graph-navigation";
import { rememberWorkingContext, restoreWorkingContext } from "../../util/graph-working-context";
import type { GraphFinderEntry } from "../../util/graph-finder";
import chroma from "chroma-js";
import Sigma from "sigma";
import type { CameraState } from "sigma/types";
import { Subscription } from "rxjs";
import { buildBackgroundCSS } from "../../../service/graph-style.service";
import type { GraphStyleService } from "../../../service/graph-style.service";

import { getTypeLabel, DataVertex } from "@typedb/graph-utils";
import { buildStructuredAnswers } from "@typedb/graph-utils";
import { AnalyzedPipelineBackCompat } from "./types";
import { Graph, GraphBuilderStructureParams, defaultStructureParams } from "./graph";
import { GraphBuilder, EDGE_CURVATURE } from "./graph-builder";
import { GraphStyles, colorEdgesByConstraintIndex as _colorEdgesByConstraintIndex, colorQuery as _colorQuery } from "./styles";
import { setUseBorderColorForLabels, setLabelsVisible, setShowHoverLabel } from "./sigma-label-utils";
import { InteractionHandler, StudioState } from "./interaction-handler";
import { LayoutWrapper, LayoutDensity } from "./layout";
import { createSigmaRenderer, defaultSigmaSettings } from "./sigma-settings";
import { DisplayAttributeStore, refreshInstanceLabels } from "./instance-label";

export type GraphPngExportMode = "currentView" | "wholeGraph";
const MAX_EXPORT_DIMENSION = 8192;

/**
 * Minimum fractional change in the auto-fit camera ratio before the per-tick
 * sim re-fit actually moves the camera. The force sim re-fits every tick, and
 * any ratio change rescales every label's font size — which rebuilds the glyph
 * atlas and makes each tick paint like a (slow) zoom instead of a (fast) pan.
 * Holding the ratio until the fit drifts past this threshold keeps the font
 * size — and the cached atlas — stable across runs of ticks. Only applied to
 * the per-tick auto-fit; explicit fits (Reset view, etc.) always apply.
 */
const AUTO_FIT_MIN_RATIO_CHANGE = 0.04;

/** The source title and comment, as shown over the live canvas: top left, on
 * a translucent plate so the graph stays visible behind longer comments. */
function drawExportCaption(ctx: CanvasRenderingContext2D, caption: { title: string; comment: string }, scale: number, width: number, background: string): void {
    const family = getComputedStyle(document.body).fontFamily || "sans-serif";
    const light = chroma(background).luminance() > 0.4;
    const maxWidth = Math.min(560, width * 0.6), pad = 8, gap = 4;
    ctx.save();
    ctx.scale(scale, scale);
    const wrap = (text: string, font: string): string[] => {
        ctx.font = font;
        return text.split("\n").flatMap(paragraph => {
            const lines: string[] = [];
            let line = "";
            for (const word of paragraph.split(/\s+/).filter(Boolean)) {
                const next = line ? `${line} ${word}` : word;
                if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; } else line = next;
            }
            return [...lines, line];
        });
    };
    const titleFont = `600 13px ${family}`, commentFont = `12px ${family}`;
    const title = caption.title ? wrap(caption.title, titleFont) : [];
    const comment = caption.comment ? wrap(caption.comment, commentFont).slice(0, 12) : [];
    const measure = (lines: string[], font: string) => { ctx.font = font; return Math.max(0, ...lines.map(l => ctx.measureText(l).width)); };
    const boxWidth = Math.max(measure(title, titleFont), measure(comment, commentFont)) + 2 * pad;
    const boxHeight = title.length * 17 + comment.length * 16 + (title.length && comment.length ? gap : 0) + 2 * pad;
    ctx.fillStyle = chroma(background).alpha(0.78).css();
    ctx.beginPath(); ctx.roundRect(12, 12, boxWidth, boxHeight, 6); ctx.fill();
    ctx.textBaseline = "top";
    let y = 12 + pad;
    ctx.fillStyle = light ? "#151515" : "#f2f2f2"; ctx.font = titleFont;
    for (const line of title) { ctx.fillText(line, 12 + pad, y); y += 17; }
    if (title.length && comment.length) y += gap;
    ctx.fillStyle = light ? "#3a3a3a" : "#c8c8c8"; ctx.font = commentFont;
    for (const line of comment) { ctx.fillText(line, 12 + pad, y); y += 16; }
    ctx.restore();
}

export class GraphVisualiser {
    interactionHandler: InteractionHandler;
    state: StudioState;
    readonly elementSelection: GraphElementSelection;
    readonly navigation = new GraphNavigation();
    correspondenceNodes = new Set<string>();
    finderMatches: Set<string> | null = null;
    searchTerm = "";
    searchMatches: Set<string> | null = null;
    private styleParams: GraphStyles;
    private structureParams: GraphBuilderStructureParams = defaultStructureParams;

    private autoZoomEnabled = true;
    private settingCameraProgrammatically = false;
    private peakCameraRatio = 0;
    private labelsAutoHidden = false;
    /**
     * When set, every layout tick re-projects this world point back to the
     * current bbox's coordinate space and snaps the camera there. Used by
     * `reheat({ preserveCamera })` so the camera stays pinned to the world
     * spot the user was looking at even as the simulation re-positions nodes
     * and Sigma's bbox shifts under it.
     */
    private pinnedCameraWorld: { worldX: number; worldY: number; ratio: number } | null = null;
    private stylesSub!: Subscription;
    private cameraUpdatedListener: (() => void) | null = null;
    /** Teardown callbacks for the WebGL stale-frame recovery listeners. */
    private contextGuardCleanups: (() => void)[] = [];
    /** Per-instance attribute values fetched purely to populate the label
     *  heuristic. Not rendered into the graph — kept off-graph so the user
     *  still has to opt in to attribute nodes/edges. */
    private displayAttributes: DisplayAttributeStore = new Map();
    /** User-set overrides for the instance-label heuristic: typeLabel →
     *  attribute type label to use as the display value. Loaded from
     *  `AppData.nodeLabelPrefs` when a tab opens; mutated from the type
     *  inspector dropdown. Independent of GraphStyleService so "Reset all
     *  styles" doesn't clear it. */
    labelOverridesByType: Map<string, string> = new Map();

    constructor(public graph: Graph, public sigma: Sigma, public layout: LayoutWrapper, public styleService: GraphStyleService) {
        this.elementSelection = new GraphElementSelection(graph.getAttribute("elementSelection"), snapshot => {
            graph.setAttribute("elementSelection", snapshot);
            this.styleService.clearPreview();
            for (const key of snapshot.nodes) {
                if (graph.hasNode(key) && graph.getNodeAttribute(key, "viewDimmed")) graph.setNodeAttribute(key, "viewDimmed", false);
            }
            this.finderMatches = null;
            this.searchMatches = null;
            this.searchTerm = "";
            this.sigma.refresh();
        });
        this.state = { activeQueryDatabase: null };
        this.styleParams = this.syncStyles();
        this.interactionHandler = new InteractionHandler(graph, sigma, this.state, this.styleParams, this.styleService);
        this.interactionHandler.visualiser = this;
        this.interactionHandler.layout = this.layout;
        this.setupReducers();
        this.layout.onTick = () => {
            if (this.pinnedCameraWorld) {
                this.restoreCameraWorld(this.pinnedCameraWorld);
            } else if (this.autoZoomEnabled) {
                this.centerCamera(false, AUTO_FIT_MIN_RATIO_CHANGE);
            }
        };
        this.cameraUpdatedListener = () => {
            if (!this.settingCameraProgrammatically) {
                this.autoZoomEnabled = false;
                // User took control — release the pin so future Explores don't
                // snap back to a stale saved position.
                this.pinnedCameraWorld = null;
            }
            this.updateLabelVisibilityForZoom();
        };
        this.sigma.getCamera().addListener("updated", this.cameraUpdatedListener);
        this.setupContextRecoveryGuards();
        this.stylesSub = this.styleService.styles$.subscribe(() => {
            this.syncStyles();
            try {
                this.applyStyleUpdate();
                this.applyEdgeStyleUpdate();
            } catch (_) { /* sigma not renderable (e.g. hidden tab, lost WebGL context) */ }
        });
    }

    /**
     * The graph renders on a WebGL layer (Sigma) composited by the OS webview.
     * On some GPUs/drivers a stale or uninitialised drawing buffer can survive
     * across a sleep/wake, GPU memory-pressure event, or context loss/restore,
     * showing up as a garbage frame (classically a flat red field with ghost
     * geometry from an earlier frame). It persists until the next real paint —
     * which is why hovering/panning makes it vanish.
     *
     * These guards force a fresh render whenever the app regains focus or
     * visibility, and when a lost GL context is restored, so a stale frame
     * self-corrects without the user having to interact with the canvas.
     */
    private setupContextRecoveryGuards(): void {
        const repaint = () => {
            try {
                this.sigma.refresh();
            } catch (_) { /* sigma not renderable (hidden tab / lost context) */ }
        };
        const onFocus = () => repaint();
        const onVisible = () => { if (!document.hidden) repaint(); };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisible);
        this.contextGuardCleanups.push(
            () => window.removeEventListener("focus", onFocus),
            () => document.removeEventListener("visibilitychange", onVisible),
        );

        this.sigma.getContainer().querySelectorAll("canvas").forEach(canvas => {
            const onRestored = () => repaint();
            canvas.addEventListener("webglcontextrestored", onRestored);
            this.contextGuardCleanups.push(
                () => canvas.removeEventListener("webglcontextrestored", onRestored),
            );
        });
    }

    private syncStyles(): GraphStyles {
        setUseBorderColorForLabels(this.styleService.labelUseBorderColor);
        // User explicitly changed label visibility — reset auto-hide state
        this.labelsAutoHidden = false;
        setLabelsVisible(this.styleService.labelsVisible);
        setShowHoverLabel(this.styleService.showHoverLabel);
        // Edge labels are controlled independently of node labels — they are by
        // far the most expensive thing to render during a sim (one per visible
        // edge, every frame), so letting users turn them off without losing node
        // labels is the main performance lever for dense / curve-heavy graphs.
        this.sigma.setSetting("renderEdgeLabels", this.styleService.edgeLabelsVisible);
        this.styleParams = this.styleService.toGraphStyles();
        if (this.interactionHandler) {
            this.interactionHandler.styleParams = this.styleParams;
        }
        this.applyBackground();
        return this.styleParams;
    }

    /**
     * When the graph has many elements and the camera is zoomed out, hide
     * node and edge labels to avoid the rendering cost of measuring and
     * drawing thousands of text strings every frame.
     */
    private updateLabelVisibilityForZoom(): void {
        // Nothing to auto-hide if the user has both label kinds turned off.
        if (!this.styleService.labelsVisible && !this.styleService.edgeLabelsVisible) return;

        const elementCount = this.graph.order + this.graph.size; // nodes + edges
        const ratio = this.sigma.getCamera().ratio;

        // More elements → hide labels at a lower (closer) zoom level.
        // At 200 elements, hide when ratio > 5; at 1000 elements, hide when ratio > 1.
        const ELEMENT_THRESHOLD = 100;
        const zoomThreshold = Math.max(4, ELEMENT_THRESHOLD * 10 / elementCount);
        const shouldHide = elementCount > ELEMENT_THRESHOLD && ratio > zoomThreshold;

        if (shouldHide === this.labelsAutoHidden) return; // no change
        this.labelsAutoHidden = shouldHide;
        // Auto-hide each label kind only if the user has it on in the first
        // place, so the zoom heuristic never re-shows labels they disabled.
        if (this.styleService.labelsVisible) setLabelsVisible(!shouldHide);
        if (this.styleService.edgeLabelsVisible) this.sigma.setSetting("renderEdgeLabels", !shouldHide);
    }

    private setupReducers(): void {
        const FADE_RATIO = 0.15; // mix 15% original color, 85% background
        const PREVIEW_FADE_RATIO = 0.3; // mix 30% original color, 70% background — gentler than the regular fade

        const fade = (color: string) => chroma.mix(this.styleService.effectiveBackgroundHex, color, FADE_RATIO).hex();
        const fadeForPreview = (color: string) => chroma.mix(this.styleService.effectiveBackgroundHex, color, PREVIEW_FADE_RATIO).hex();
        const buildFadeSoft = (alpha: number) => (color: string) => {
            // Output premultiplied-alpha hex for Sigma's gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA)
            const [r, g, b] = chroma(color).rgb();
            const pr = Math.round(r * alpha);
            const pg = Math.round(g * alpha);
            const pb = Math.round(b * alpha);
            const pa = Math.round(alpha * 255);
            return `#${pr.toString(16).padStart(2, "0")}${pg.toString(16).padStart(2, "0")}${pb.toString(16).padStart(2, "0")}${pa.toString(16).padStart(2, "0")}`;
        };
        const fadeSoft = buildFadeSoft(0.25);
        const fadeSoftForPreview = buildFadeSoft(0.3);

        this.sigma.setSetting("nodeReducer", (node, data) => {
            if (data["viewHidden"]) return { ...data, hidden: true, label: "" };
            const state = this.interactionHandler.state;
            // The node being dragged is lifted above all others so its body,
            // label, and hover overlay stack as one consistent group on top.
            // A drag re-indexes every move (x/y are layout-impacting), so this
            // elevated zIndex propagates to the body draw order, the label
            // draw order (renderLabels sorts by the same nodeIndices), and to
            // picking — keeping the dragged node the hovered one throughout.
            data = { ...data, lineThickness: this.styleService.getNodeLineThickness(data["metadata"].concept.kind, getTypeLabel(data["metadata"].concept as any)),
                lineStyle: this.styleService.getNodeLineStyle(data["metadata"].concept.kind, getTypeLabel(data["metadata"].concept as any)) };
            if (this.correspondenceNodes.has(node)) data = { ...data, highlighted: true, correspondenceMarker: true,
                keyboardCaretColor: chroma(this.styleService.effectiveBackgroundHex).luminance() > 0.4 ? "#151515" : "#ffffff" };
            if (this.navigation.caret === node && this.navigation.mode !== "normal") {
                data = { ...data, highlighted: true, keyboardCaret: true,
                    keyboardCaretColor: chroma(this.styleService.effectiveBackgroundHex).luminance() > 0.4 ? "#151515" : "#ffffff" };
            }
            if (node === state.draggedNode) return { ...data, zIndex: 2 };
            let shouldFade = false;
            let isPreviewFade = false;

            // Explicit shared selection takes priority, followed by search previews.
            const matches = this.elementSelection.active ? this.elementSelection.nodes : (this.finderMatches ?? this.searchMatches);
            if (matches != null) {
                shouldFade = !matches.has(node);
            } else {
                // Inspection and the caret never change the highlight set.
                try {
                    const concept = data["metadata"].concept;
                    if (this.styleService.isHighlightActive()) {
                        shouldFade = !this.styleService.shouldHighlightNode(concept.kind as any, getTypeLabel(concept as any));
                    } else if (this.styleService.isPreviewActive()) {
                        shouldFade = !this.styleService.shouldPreviewNode(concept.kind as any, getTypeLabel(concept as any));
                        isPreviewFade = shouldFade;
                    }
                } catch (_) { /* guard against missing metadata during graph mutations */ }
            }

            // Lift the hovered node above its peers so body + label come to the
            // front together (a faded node keeps its blanked label, so there's
            // nothing to lift — leave it at the normal level).
            if (data["viewDimmed"]) { shouldFade = true; isPreviewFade = false; }
            if (!shouldFade) return { ...data, zIndex: node === state.hoveredNode ? 2 : 1 };
            const res = { ...data };
            if (isPreviewFade) {
                res["color"] = fadeSoftForPreview(data["color"]);
                if (data["borderColor"]) res["borderColor"] = fadeSoftForPreview(data["borderColor"]);
                // Keep the label visible for a subtle preview
                res["zIndex"] = 0;
            } else {
                res["color"] = fadeSoft(data["color"]);
                if (data["borderColor"]) res["borderColor"] = fadeSoft(data["borderColor"]);
                res["label"] = "";
                res["zIndex"] = 0;
            }
            return res;
        });

        this.sigma.setSetting("edgeReducer", (edge, data) => {
            data = { ...data, label: edgeDisplayLabel(data), size: data["size"] * this.styleService.getEdgeLineThickness(edgeStyleKey(data)),
                roleArrow: this.styleService.getRoleArrow(edgeStyleKey(data)), lineStyle: this.styleService.getEdgeLineStyle(edgeStyleKey(data)) };
            if (this.interactionHandler.inspectedEdge === edge) data = { ...data, size: data["size"] + 1, forceLabel: true };
            const endpoints = this.graph.extremities(edge).map(node => this.graph.getNodeAttributes(node));
            if (endpoints.some(node => node["viewHidden"])) return { ...data, hidden: true, label: "" };
            let shouldFade = false;
            let isPreviewFade = false;

            // Explicit shared selection takes priority, followed by search previews.
            const matches = this.elementSelection.active ? this.elementSelection.nodes : (this.finderMatches ?? this.searchMatches);
            if (matches != null) {
                const source = this.graph.source(edge);
                const target = this.graph.target(edge);
                shouldFade = !matches.has(source) || !matches.has(target);
                const tag = data["metadata"]?.dataEdge?.tag;
                if (tag && !this.styleService.shouldHighlightEdge(tag)) shouldFade = true;
            } else {
                try {
                    if (this.styleService.isHighlightActive()) {
                        const source = this.graph.source(edge);
                        const target = this.graph.target(edge);
                        const sourceAttrs = this.graph.getNodeAttributes(source);
                        const targetAttrs = this.graph.getNodeAttributes(target);
                        const sourceConcept = sourceAttrs.metadata.concept;
                        const targetConcept = targetAttrs.metadata.concept;
                        const sourceHighlighted = this.styleService.shouldHighlightNode(sourceConcept.kind as any, getTypeLabel(sourceConcept as any));
                        const targetHighlighted = this.styleService.shouldHighlightNode(targetConcept.kind as any, getTypeLabel(targetConcept as any));
                        if (!sourceHighlighted || !targetHighlighted) {
                            shouldFade = true;
                        }
                        const tag = this.graph.getEdgeAttributes(edge).metadata?.dataEdge?.tag;
                        if (tag && !this.styleService.shouldHighlightEdge(tag)) {
                            shouldFade = true;
                        }
                    } else if (this.styleService.isPreviewActive()) {
                        const source = this.graph.source(edge);
                        const target = this.graph.target(edge);
                        const sourceAttrs = this.graph.getNodeAttributes(source);
                        const targetAttrs = this.graph.getNodeAttributes(target);
                        const sourceConcept = sourceAttrs.metadata.concept;
                        const targetConcept = targetAttrs.metadata.concept;
                        const sourcePreviewed = this.styleService.shouldPreviewNode(sourceConcept.kind as any, getTypeLabel(sourceConcept as any));
                        const targetPreviewed = this.styleService.shouldPreviewNode(targetConcept.kind as any, getTypeLabel(targetConcept as any));
                        if (!sourcePreviewed || !targetPreviewed) {
                            shouldFade = true;
                            isPreviewFade = true;
                        }
                        const tag = this.graph.getEdgeAttributes(edge).metadata?.dataEdge?.tag;
                        if (tag && !this.styleService.shouldPreviewEdge(tag)) {
                            shouldFade = true;
                            isPreviewFade = true;
                        }
                    }
                } catch (_) { /* guard against missing metadata during graph mutations */ }
            }

            if (endpoints.some(node => node["viewDimmed"])) { shouldFade = true; isPreviewFade = false; }
            if (!shouldFade) return { ...data, zIndex: 1 };
            const res = { ...data };
            res["color"] = (isPreviewFade ? fadeForPreview : fade)(data["color"] ?? "#ccc");
            if (!isPreviewFade) res["label"] = "";
            res["zIndex"] = 0;
            return res;
        });
    }

    applyStyleUpdate(): void {
        this.syncStyles();
        const useDegreeScaling = this.styleService.degreeScaling;
        this.graph.nodes().forEach(nodeKey => {
            const attrs = this.graph.getNodeAttributes(nodeKey);
            const concept = attrs.metadata.concept;
            const style = this.styleService.resolveNodeStyle(concept.kind as any, getTypeLabel(concept as any));
            this.graph.setNodeAttribute(nodeKey, "color", style.fillColor);
            this.graph.setNodeAttribute(nodeKey, "borderColor", style.color);
            this.graph.setNodeAttribute(nodeKey, "type", style.shape);
            if (useDegreeScaling) {
                const degree = this.graph.degree(nodeKey);
                const w = style.width + Math.min(degree * 2, style.width * 4);
                const h = style.height + Math.min(degree * 2, style.height * 4);
                this.graph.setNodeAttribute(nodeKey, "width", w);
                this.graph.setNodeAttribute(nodeKey, "height", h);
                this.graph.setNodeAttribute(nodeKey, "size", Math.max(w, h));
            } else {
                this.graph.setNodeAttribute(nodeKey, "width", style.width);
                this.graph.setNodeAttribute(nodeKey, "height", style.height);
                this.graph.setNodeAttribute(nodeKey, "size", Math.max(style.width, style.height));
            }
        });
        this.sigma.refresh();
    }

    applyEdgeStyleUpdate(): void {
        this.syncStyles();
        if (!this.styleService.colorEdgesByConstraint) {
            this.colorEdgesByConstraintIndex(true);
        }
        this.sigma.refresh();
    }

    /**
     * Re-apply the curved-vs-straight edge type to every existing edge based on
     * the current `edgesCurvedByDefault` setting. Parallel edges between the
     * same pair stay curved (and fanned out) regardless, so they don't overlap.
     */
    applyEdgeCurvature(): void {
        const curvedByDefault = this.styleService.edgesCurvedByDefault;
        const groups = new Map<string, string[]>();
        this.graph.forEachEdge((edge, _attrs, source, target) => {
            const key = JSON.stringify([source, target].sort());
            const group = groups.get(key) ?? [];
            group.push(edge); groups.set(key, group);
        });
        for (const edges of groups.values()) edges.sort().forEach((edge, index) => {
            this.graph.mergeEdgeAttributes(edge, parallelEdgeGeometry(index, edges.length,
                this.graph.source(edge), this.graph.target(edge), curvedByDefault));
        });
        this.sigma.refresh();
    }

    /** The caret, its history and secondary markers survive a re-layout: only
     * positions change, so the same node stays inspected. */
    reLayout(): void {
        this.stopCameraAnimation();
        const restartFromCurrent = this.layout.isRunning;
        this.layout.stop();
        this.autoZoomEnabled = true;
        this.peakCameraRatio = 0;
        this.pinnedCameraWorld = null;
        this.unfreezeViewport();
        if (!restartFromCurrent) this.graph.nodes().forEach(node => {
            this.graph.setNodeAttribute(node, "x", Math.random());
            this.graph.setNodeAttribute(node, "y", Math.random());
        });
        // Release old settling/pin constraints. During a running layout, the
        // current coordinates become the starting point of the replacement simulation.
        this.layout.forgetSettled();
        this.layout.startOrRedraw();
        this.centerCamera();
    }

    /**
     * Resume the layout simulation so newly added nodes settle into the
     * existing graph. Unlike `reLayout`, this preserves current node
     * positions — the simulation restarts from where things are now.
     *
     * - `soft`: use a lower initial alpha + higher alpha decay so the
     *   simulation perturbs the layout less and settles faster. Good for
     *   incremental Explore/Add actions where we don't want the existing
     *   layout to swirl.
     * - `preserveCamera`: don't re-enable auto-zoom and don't recenter.
     *   Use when the user has framed the view themselves and an Explore
     *   shouldn't yank the camera around.
     */
    /**
     * Pin the current bbox so that subsequent graph mutations (new nodes
     * appearing, simulation re-laying out positions) don't visually shift
     * the camera: Sigma stores the camera in coords normalized to the bbox,
     * so an auto-growing bbox makes the same camera state cover more world
     * space — which looks like a zoom-out. Same trick used in
     * `onDownNode` when a drag begins. No-op if already pinned.
     */
    freezeViewport(): void {
        if (!this.sigma.getCustomBBox()) {
            this.sigma.setCustomBBox(this.sigma.getBBox());
        }
    }

    /** Release the pinned bbox so Sigma resumes auto-fitting to the graph. */
    unfreezeViewport(): void {
        this.sigma.setCustomBBox(null);
    }

    /**
     * Hold the camera still for the duration of a node drag. Dragging now
     * reheats the simulation (so neighbours move out of the way), which makes
     * the per-tick `onTick` fire — without this it would auto-recenter/zoom and
     * the view would lurch mid-drag. Freezes the bbox, turns off auto-zoom, and
     * pins the camera to its current world point so `onTick` snaps it back.
     */
    holdCameraForDrag(): void {
        this.autoZoomEnabled = false;
        this.freezeViewport();
        this.pinnedCameraWorld = this.captureCameraWorld();
    }

    /**
     * Capture the camera's current world coordinates + ratio. Combined with
     * `restoreCameraWorld`, this lets a caller pin the camera to the same
     * world point across operations that mutate the bbox.
     */
    captureCameraWorld(): { worldX: number; worldY: number; ratio: number } {
        const cam = this.sigma.getCamera().getState();
        const bbox = this.sigma.getCustomBBox() ?? this.sigma.getBBox();
        const bboxW = (bbox.x[1] - bbox.x[0]) || 1;
        const bboxH = (bbox.y[1] - bbox.y[0]) || 1;
        return {
            worldX: bbox.x[0] + cam.x * bboxW,
            worldY: bbox.y[0] + cam.y * bboxH,
            ratio: cam.ratio,
        };
    }

    /** Convert saved world coords back to current-bbox-relative camera state. */
    restoreCameraWorld(saved: { worldX: number; worldY: number; ratio: number }): void {
        const bbox = this.sigma.getCustomBBox() ?? this.sigma.getBBox();
        const bboxW = (bbox.x[1] - bbox.x[0]) || 1;
        const bboxH = (bbox.y[1] - bbox.y[0]) || 1;
        const x = (saved.worldX - bbox.x[0]) / bboxW;
        const y = (saved.worldY - bbox.y[0]) / bboxH;
        this.settingCameraProgrammatically = true;
        this.sigma.getCamera().setState({ x, y, ratio: saved.ratio, angle: 0 });
        this.settingCameraProgrammatically = false;
    }

    /** Shared zoom step. A selection anchors zoom at its screen-space centre. */
    zoom(direction: "in" | "out"): void {
        const camera = this.sigma.getCamera();
        const bounds = this.elementSelection.active ? this.navigationBounds([...this.elementSelection.nodes]) : null;
        const { width, height } = this.sigma.getDimensions();
        const anchor = bounds ? { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 } : { x: width / 2, y: height / 2 };
        const ratio = camera.getBoundedRatio(camera.ratio * (direction === "in" ? 0.7 : 1 / 0.7));
        this.animateNavigationCamera(this.sigma.getViewportZoomedState(anchor, ratio));
    }

    /** Enter at the rendered node nearest the viewport centre, independently of selection. */
    enterNavigation(): boolean {
        const points = this.navigationPoints();
        const { width, height } = this.sigma.getDimensions();
        const visible = points.filter(p => p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height);
        const caret = (visible.length ? visible : points).sort((a, b) =>
            Math.hypot(a.x - width / 2, a.y - height / 2) - Math.hypot(b.x - width / 2, b.y - height / 2) || a.key.localeCompare(b.key))[0]?.key;
        return !!caret && this.pointCaret(caret, "none", true);
    }

    /** One primary caret plus dotted secondary carets on the other matches.
     * Selection is unchanged; only the primary is panned into view. */
    pointCarets(keys: string[], primary = keys[0]): boolean {
        const visible = keys.filter(key => this.graph.hasNode(key) && !this.graph.getNodeAttribute(key, "viewHidden"));
        this.correspondenceNodes = new Set(visible.length > 1 ? visible : []);
        if (primary && visible.includes(primary) && this.pointCaret(primary, "none", true)) return true;
        this.sigma.refresh();
        return false;
    }

    /** Pointer and hint jumps inspect exactly one node without implicitly selecting it. */
    pointCaret(key: string, edit: GraphSelectionEdit = "none", follow = false): boolean {
        if (!this.graph.hasNode(key) || this.graph.getNodeAttribute(key, "viewHidden")) return false;
        this.layout.stop(); this.freezeViewport(); this.stopCameraAnimation();
        this.navigation.visit(key);
        this.editCaretSelection(key, edit);
        this.interactionHandler.inspectKeyboardNode(key);
        this.sigma.refresh();
        if (follow) this.followNavigation([key]);
        return true;
    }

    moveNavigation(direction: GraphDirection, edit: GraphSelectionEdit = "none"): boolean {
        this.layout.stop(); this.freezeViewport();
        const caret = this.navigation.caret;
        const connected = new Set(caret && this.graph.hasNode(caret) ? this.graph.neighbors(caret) : []);
        if (!this.navigation.move(direction, this.navigationPoints(), connected)) { this.sigma.refresh(); return false; }
        const key = this.navigation.caret!;
        this.editCaretSelection(key, edit);
        this.interactionHandler.inspectKeyboardNode(key);
        this.sigma.refresh();
        this.followNavigation([key]);
        return true;
    }

    /** Adjust only the caret node by five screen pixels, without moving the
     * camera, visiting another node, or reheating its neighbours. */
    nudgeCaret(direction: GraphDirection): boolean {
        const key = this.navigation.caret;
        if (!key || !this.graph.hasNode(key) || this.graph.getNodeAttribute(key, "viewHidden")) return false;
        this.layout.stop(); this.freezeViewport(); this.stopCameraAnimation(); this.sigma.refresh();
        const attrs = this.graph.getNodeAttributes(key);
        if (!Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) return false;
        const point = this.sigma.graphToViewport(attrs), [dx, dy] = graphDirectionVectors[direction];
        const position = this.sigma.viewportToGraph({ x: point.x + dx * 5, y: point.y + dy * 5 });
        this.autoZoomEnabled = false; this.pinnedCameraWorld = null;
        this.graph.mergeNodeAttributes(key, position);
        this.layout.pinNode?.(key, position.x, position.y);
        this.sigma.refresh();
        return true;
    }

    backNavigation(): boolean {
        if (!this.navigation.caret) return false;
        this.layout.stop(); this.freezeViewport(); this.stopCameraAnimation();
        if (!this.navigation.back(this.navigationPoints())) { this.sigma.refresh(); return false; }
        const key = this.navigation.caret!;
        this.interactionHandler.inspectKeyboardNode(key);
        this.sigma.refresh();
        this.followNavigation([key]);
        return true;
    }

    private editCaretSelection(key: string, edit: GraphSelectionEdit): void {
        if (edit === "none") return;
        const selected = this.highlightedNodeKeys();
        // Freeze the effective highlight only when an edit actually changes membership.
        if (selected.includes(key) !== (edit === "add")) this.elementSelection.toggleSingle(key, selected);
    }

    /** Freeze hint geometry and expose only nodes whose centres are on screen. */
    graphHintPoints(): GraphNavigationPoint[] {
        this.layout.stop(); this.freezeViewport(); this.stopCameraAnimation();
        // Camera updates schedule rendering; hints need current projection immediately.
        this.sigma.refresh();
        const { width, height } = this.sigma.getDimensions();
        return this.navigationPoints().filter(p => p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height);
    }

    private stopCameraAnimation(): void {
        const camera = this.sigma.getCamera();
        if (camera.isAnimated()) void camera.animate(camera.getState(), { duration: 0 });
    }

    endNavigation(): void {
        this.correspondenceNodes.clear();
        this.navigation.reset(); this.stopCameraAnimation(); this.sigma.refresh();
    }

    clearGraphSelection(): void {
        this.endNavigation();
        this.interactionHandler.setSecondaryAnchors(new Set());
        this.interactionHandler.clearSelection();
        this.clearSearch();
        this.styleService.clearHighlights();
        this.elementSelection.clear();
    }

    private navigationPoints(): GraphNavigationPoint[] {
        const points: GraphNavigationPoint[] = [];
        const cameraState = this.sigma.getCamera().getState();
        for (const key of this.graph.nodes()) {
            const attrs = this.graph.getNodeAttributes(key);
            const data = this.sigma.getNodeDisplayData(key);
            if (attrs.viewHidden || !data || data.hidden || !Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) continue;
            const point = this.sigma.graphToViewport({ x: attrs.x, y: attrs.y }, { cameraState });
            const rawW = attrs.width ?? data.size, rawH = attrs.height ?? data.size;
            const scale = this.sigma.scaleSize(data.size, cameraState.ratio) / Math.max(rawW, rawH, 1);
            if (Number.isFinite(point.x) && Number.isFinite(point.y)) points.push({ key, ...point,
                halfWidth: rawW * scale, halfHeight: rawH * scale });
        }
        return points;
    }

    /** Node bodies (including a small caret/label margin), in viewport pixels. */
    private navigationBounds(keys: string[], cameraState = this.sigma.getCamera().getState()) {
        let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
        for (const key of keys) {
            if (!this.graph.hasNode(key)) continue;
            const data = this.sigma.getNodeDisplayData(key);
            if (!data || data.hidden) continue;
            const point = this.sigma.framedGraphToViewport(data, { cameraState });
            const attrs = this.graph.getNodeAttributes(key);
            const rawW = attrs.width ?? data.size, rawH = attrs.height ?? data.size;
            const scale = this.sigma.scaleSize(data.size, cameraState.ratio) / Math.max(rawW, rawH, 1);
            const rx = rawW * scale + 10, ry = rawH * scale + 10;
            left = Math.min(left, point.x - rx); right = Math.max(right, point.x + rx);
            top = Math.min(top, point.y - ry); bottom = Math.max(bottom, point.y + ry);
        }
        return Number.isFinite(left) ? { left, right, top, bottom } : null;
    }

    private animateNavigationCamera(target: CameraState): void {
        this.autoZoomEnabled = false; this.pinnedCameraWorld = null;
        void this.sigma.getCamera().animate(target, { duration: document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150 });
    }

    /** Position the caret at a viewport fraction, preserving zoom and rotation. */
    centreCaret(x = 0.5, y = 0.5): boolean {
        const key = this.navigation.caret;
        if (!key || !this.graph.hasNode(key) || this.graph.getNodeAttribute(key, "viewHidden")) return false;
        this.layout.stop(); this.freezeViewport(); this.stopCameraAnimation(); this.sigma.refresh();
        const data = this.sigma.getNodeDisplayData(key);
        if (!data || data.hidden) return false;
        const camera = this.sigma.getCamera().getState();
        const { width, height } = this.sigma.getDimensions();
        if (!width || !height) return false;
        const anchor = this.sigma.viewportToFramedGraph({ x: width * x, y: height * y });
        this.animateNavigationCamera({ ...camera, x: camera.x + data.x - anchor.x, y: camera.y + data.y - anchor.y });
        return true;
    }

    panNavigation(direction: GraphCardinalDirection): void {
        const { width, height } = this.sigma.getDimensions();
        if (!width || !height) return;
        const distance = Math.min(width, height) * 0.1;
        const dx = direction === "left" ? -distance : direction === "right" ? distance : 0;
        const dy = direction === "up" ? -distance : direction === "down" ? distance : 0;
        const centre = this.sigma.viewportToFramedGraph({ x: width / 2 + dx, y: height / 2 + dy });
        this.animateNavigationCamera({ ...this.sigma.getCamera().getState(), ...centre });
    }

    /** Follow the caret at viewport edges by panning only; Enter explicitly fits
     * (and may zoom) the highlighted set. Nodes already in view do not move. */
    private followNavigation(keys: string[], fit = false): void {
        const { width, height } = this.sigma.getDimensions();
        if (!width || !height || !keys.length) return;
        const marginX = Math.min(70, width * 0.15), marginY = Math.min(90, height * 0.18);
        const areaW = width - 2 * marginX, areaH = height - 2 * marginY;
        const camera = this.sigma.getCamera(), initial = camera.getState();
        let target = { ...initial };
        // Sigma scales node glyphs with the square root of zoom. Iterate the fit
        // against actual projected bodies instead of treating them as points.
        if (fit) for (let i = 0; i < 5; i++) {
            const bounds = this.navigationBounds(keys, target);
            if (!bounds) return;
            const factor = Math.max((bounds.right - bounds.left) / areaW, (bounds.bottom - bounds.top) / areaH);
            target.ratio = camera.getBoundedRatio(Math.max(0.08, Math.min(20, target.ratio * factor)));
        }
        const bounds = this.navigationBounds(keys, target);
        if (!bounds) return;
        const dx = fit || bounds.right - bounds.left > areaW ? (bounds.left + bounds.right - width) / 2
            : bounds.left < marginX ? bounds.left - marginX : bounds.right > width - marginX ? bounds.right - width + marginX : 0;
        const dy = fit || bounds.bottom - bounds.top > areaH ? (bounds.top + bounds.bottom - height) / 2
            : bounds.top < marginY ? bounds.top - marginY : bounds.bottom > height - marginY ? bounds.bottom - height + marginY : 0;
        const centre = this.sigma.viewportToFramedGraph({ x: width / 2 + dx, y: height / 2 + dy }, { cameraState: target });
        target = { ...target, ...centre };
        if (dx || dy || target.ratio !== initial.ratio || camera.isAnimated()) this.animateNavigationCamera(target);
    }

    removeSelectedFromGraph(): number {
        return this.removeNavigationNodes(this.elementSelection.active ? [...this.elementSelection.nodes] : []);
    }

    removeCaretFromGraph(): number {
        const caret = this.navigation.caret;
        return this.removeNavigationNodes(caret ? [caret] : []);
    }

    private removeNavigationNodes(keys: string[]): number {
        const existing = keys.filter(key => this.graph.hasNode(key));
        if (!existing.length) return 0;
        this.layout.stop(); this.stopCameraAnimation();
        const modal = this.navigation.mode !== "normal";
        const previous = this.navigationPoints().find(p => p.key === this.navigation.caret);
        const connected = new Set(previous ? this.graph.neighbors(previous.key) : []);
        this.navigation.reset();
        this.rememberContext(); this.freezeViewport();
        this.dropNodes(existing);
        if (modal) {
            const remaining = this.navigationPoints().sort((a, b) =>
                Number(b.key === previous?.key) - Number(a.key === previous?.key)
                || Number(connected.has(b.key)) - Number(connected.has(a.key))
                || (previous ? Math.hypot(a.x - previous.x, a.y - previous.y) - Math.hypot(b.x - previous.x, b.y - previous.y) : 0)
                || a.key.localeCompare(b.key));
            if (remaining[0]) { this.pointCaret(remaining[0].key); }
        }
        this.sigma.refresh();
        return existing.length;
    }

    reheat(opts?: { soft?: boolean; preserveCamera?: boolean }): void {
        if (opts?.preserveCamera) {
            // Force off — without this, an already-true `autoZoomEnabled`
            // would have the onTick callback recentering the camera on every
            // frame as nodes shift around.
            this.autoZoomEnabled = false;
            // Pin the camera to the world point it's currently looking at so
            // the per-tick onTick callback can snap it back there as the
            // simulation re-positions things and Sigma's bbox shifts.
            this.pinnedCameraWorld = this.captureCameraWorld();
        } else {
            this.autoZoomEnabled = true;
            this.peakCameraRatio = 0;
            this.pinnedCameraWorld = null;
        }
        if (opts?.soft) {
            this.layout.start({ initialAlpha: 0.5, alphaDecay: 0.04 });
        } else {
            this.layout.start();
        }
        if (opts?.preserveCamera) {
            // An Explore/Add reheat preserves the camera, but the simulation
            // can still fling the explored node itself out of view as new
            // neighbours add their forces. Pin that node at its current
            // position for this run so the new nodes settle around it while it
            // (and the preserved camera) stay put. `start()` has just rebuilt
            // the simulation, so the node exists to be fixed; the fix lasts
            // only for this run (the next simulation is built fresh).
            this.pinFocusedNodeForReheat();
        } else {
            this.centerCamera();
        }
    }

    /**
     * Fix the currently-selected node in the running simulation at its present
     * position, so a `preserveCamera` reheat grows new nodes around it instead
     * of letting the explored node drift off-screen. No-op if nothing is
     * selected or the node has no position yet.
     */
    private pinFocusedNodeForReheat(): void {
        const anchor = this.interactionHandler.state.selectedNode;
        if (anchor == null || !this.graph.hasNode(anchor)) return;
        const x = this.graph.getNodeAttribute(anchor, "x");
        const y = this.graph.getNodeAttribute(anchor, "y");
        if (x == null || y == null) return;
        this.layout.fixNode(anchor, x, y);
    }

    centerCamera(zoomOutOnly = false, minRatioChangeFraction = 0): void {
        const nodes = this.graph.nodes();
        if (nodes.length === 0) return;

        const { width, height } = this.sigma.getDimensions();
        if (width === 0 || height === 0) return;

        // Reset view should always re-fit the entire graph; clear any pinned
        // bbox so x/y = 0.5 actually centers on the full extent rather than
        // on a stale frozen subregion.
        this.unfreezeViewport();
        this.pinnedCameraWorld = null;

        // Compute graph bounding box in graph coordinates
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        nodes.forEach(node => {
            const attrs = this.graph.getNodeAttributes(node);
            minX = Math.min(minX, attrs.x);
            maxX = Math.max(maxX, attrs.x);
            minY = Math.min(minY, attrs.y);
            maxY = Math.max(maxY, attrs.y);
        });

        // With autoRescale off, sigma maps 1 graph unit ≈ 1 pixel (centered on graph center).
        // Camera ratio = how much of the viewport-sized region to show.
        // ratio=1 shows a viewport-sized window. We need ratio = graphExtent / viewportSize.
        const graphWidth = maxX - minX || 1;
        const graphHeight = maxY - minY || 1;
        const padding = 1.1;
        const rawRatio = Math.max(graphWidth / width, graphHeight / height, 1) * padding;
        // Cap ratio so nodes (rendered at fixed screen-pixel sizes) remain visible
        const ratio = Math.min(rawRatio, 20);

        // During simulation, only zoom out (grow ratio), never zoom back in
        if (zoomOutOnly && ratio <= this.peakCameraRatio) {
            this.settingCameraProgrammatically = true;
            this.sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: this.peakCameraRatio, angle: 0 });
            this.settingCameraProgrammatically = false;
            return;
        }

        // Skip imperceptible per-tick auto-fit nudges so the camera ratio — and
        // therefore the label font size and its cached glyph atlas — stays put
        // across runs of sim ticks, instead of rescaling (and rebuilding the
        // atlas) every frame. The camera snaps once the fit drifts past the
        // threshold. Explicit fits pass 0 and always apply.
        if (minRatioChangeFraction > 0) {
            const currentRatio = this.sigma.getCamera().getState().ratio;
            if (currentRatio > 0 && Math.abs(ratio - currentRatio) / currentRatio < minRatioChangeFraction) {
                return;
            }
        }
        this.peakCameraRatio = ratio;

        this.settingCameraProgrammatically = true;
        this.sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio, angle: 0 });
        this.settingCameraProgrammatically = false;
    }

    handleQueryResponse(res: ApiResponse<QueryResponse>, database: string, preserveSelection = false) {
        if (isApiErrorResponse(res)) return;

        if (res.ok.answerType === "conceptRows") {
            // Snapshot whether the graph was empty *before* this push. A
            // first-time push (e.g. opening a new type tab) gets the full
            // auto-fit treatment; subsequent incremental pushes (Inspector
            // Explore/Add actions) leave the camera and layout supervisor
            // alone so the user's focused view isn't yanked away. The
            // inspector kicks its own `reheat({ preserveCamera })` after.
            const wasEmpty = this.graph.order === 0;
            const previousNodes = this.elementSelection.active && !preserveSelection ? new Set(this.graph.nodes()) : null;
            this.state.activeQueryDatabase = database;
            this.handleQueryResult(res);
            if (previousNodes) this.elementSelection.includeAddedNodes(this.graph.nodes().filter(key => !previousNodes.has(key)));
            if (this.styleService.degreeScaling) this.applyStyleUpdate();
            if (wasEmpty && this.graph.order > 0) {
                this.autoZoomEnabled = true;
                this.peakCameraRatio = 0;
                this.layout.startOrRedraw();
                this.centerCamera();
            }
        }
    }

    /** Place incremental editor illustrations near their existing neighbours.
     * Preserve every old coordinate and the camera; do not re-layout the view. */
    placeIllustrationNodes(previous: ReadonlySet<string>): void {
        this.layout.stop(); this.freezeViewport(); this.stopCameraAnimation();
        const { width, height } = this.sigma.getDimensions();
        const added = this.graph.nodes().filter(key => !previous.has(key));
        this.sigma.refresh();
        const bodies = new Map(this.navigationPoints().map(point => [point.key, point]));
        const occupied = [...bodies.values()].filter(point => previous.has(point.key));
        added.forEach((key, index) => {
            const neighbours = this.graph.neighbors(key).filter(node => previous.has(node) && !this.graph.getNodeAttribute(node, "viewHidden"));
            const points = neighbours.map(node => this.sigma.graphToViewport(this.graph.getNodeAttributes(node)));
            const centre = points.length ? { x: points.reduce((n, p) => n + p.x, 0) / points.length, y: points.reduce((n, p) => n + p.y, 0) / points.length }
                : { x: width / 2, y: height / 2 };
            const body = bodies.get(key);
            let destination = centre, best = Infinity;
            for (let step = 0; step < 64; step++) {
                const angle = (index + step) * 2.399963, distance = 100 + 45 * Math.sqrt(step);
                const candidate = { x: centre.x + Math.cos(angle) * distance, y: centre.y + Math.sin(angle) * distance };
                const overlap = occupied.reduce((sum, point) => sum
                    + Math.max(0, (body?.halfWidth ?? 40) + (point.halfWidth ?? 40) + 18 - Math.abs(point.x - candidate.x))
                    * Math.max(0, (body?.halfHeight ?? 25) + (point.halfHeight ?? 25) + 18 - Math.abs(point.y - candidate.y)), 0);
                if (overlap < best) { best = overlap; destination = candidate; }
                if (overlap === 0) break;
            }
            occupied.push({ key, ...destination, halfWidth: body?.halfWidth, halfHeight: body?.halfHeight });
            const position = this.sigma.viewportToGraph(destination);
            this.graph.mergeNodeAttributes(key, position);
        });
        this.sigma.refresh();
    }

    handleQueryResult(res: ApiResponse<QueryResponse>) {
        if (isApiErrorResponse(res)) return;
        if (res.ok.answerType == "conceptRows" && res.ok.query != null) {
            (window as any)._lastQueryAnswers = res.ok.answers; // TODO: Remove once schema based autocomplete is stable.
            let builder = new GraphBuilder(this.graph, res.ok.query, false, this.structureParams, this.styleParams);
            let answers = buildStructuredAnswers(res.ok as any);
            builder.build(answers);
            refreshInstanceLabels(this.graph, this.displayAttributes, this.labelOverridesByType);
        }
    }

    /**
     * Parse a conceptRows response shaped like `match $owner has $a;` and
     * record each (owner-iid, attribute-type-label) → value pair in the
     * off-graph display-attribute store. Used to feed the label heuristic
     * without ever drawing the attribute nodes/edges.
     */
    recordDisplayAttributes(res: ApiResponse<QueryResponse>, ownerVar: string, attrVar: string = "a"): void {
        if (isApiErrorResponse(res)) return;
        if (res.ok.answerType !== "conceptRows") return;
        for (const answer of (res.ok as any).answers) {
            const data = answer.data as Record<string, any>;
            const owner = data[ownerVar];
            const attr = data[attrVar];
            if (!owner?.iid || !attr || attr.kind !== "attribute") continue;
            const typeLabel: string | undefined = attr.type?.label;
            if (!typeLabel) continue;
            let perOwner = this.displayAttributes.get(owner.iid);
            if (!perOwner) {
                perOwner = new Map();
                this.displayAttributes.set(owner.iid, perOwner);
            }
            // Multi-valued attributes: append rather than overwrite so each
            // (owner, attr-type) pair holds every value the row stream
            // reports. Dedup happens later at format time.
            let values = perOwner.get(typeLabel);
            if (!values) {
                values = [];
                perOwner.set(typeLabel, values);
            }
            values.push(attr.value);
        }
    }

    /** Recompute every entity / relation label from the latest graph state +
     *  off-graph display-attribute store. Cheap; safe to call after any new
     *  data arrives. */
    refreshLabels(): void {
        refreshInstanceLabels(this.graph, this.displayAttributes, this.labelOverridesByType);
    }

    /** Replace the full override map (e.g. when loading from AppData). */
    applyLabelOverrides(overrides: Map<string, string>): void {
        this.labelOverridesByType = new Map(overrides);
        this.refreshLabels();
    }

    /** Set or clear a single type's override and refresh labels. UI hook
     *  for the type-detail dropdown — persisting to AppData is the caller's
     *  responsibility. */
    setLabelOverride(typeLabel: string, attrTypeLabel: string | null): void {
        if (attrTypeLabel) this.labelOverridesByType.set(typeLabel, attrTypeLabel);
        else this.labelOverridesByType.delete(typeLabel);
        this.refreshLabels();
    }

    /** Drop the off-graph display-attribute store. Used by `resetTab` so a
     *  reset starts from a clean slate; new fetches will repopulate. */
    clearDisplayAttributes(): void {
        this.displayAttributes.clear();
    }

    handleExplorationQueryResult(res: ApiResponse<QueryResponse>) {
        if (isApiErrorResponse(res)) return;

        if (res.ok.answerType == "conceptRows" && res.ok.query != null) {
            let builder = new GraphBuilder(this.graph, res.ok.query, true, this.structureParams, this.styleParams);
            let answers = buildStructuredAnswers(res.ok as any);
            builder.build(answers);
            refreshInstanceLabels(this.graph, this.displayAttributes, this.labelOverridesByType);
            if (this.styleService.degreeScaling) this.applyStyleUpdate();
        }
    }

    searchGraph(term: string) {
        this.searchTerm = term;
        if (term === "") {
            this.searchMatches = null;
            this.sigma.refresh();
            return;
        }

        const safeString = (str: unknown): string =>
            str == null ? "" : String(str).toLowerCase();

        const matches = new Set<string>();
        this.graph.nodes().forEach(node => {
            const attributes = this.graph.getNodeAttributes(node);
            if ("concept" in attributes["metadata"]) {
                const concept = attributes["metadata"].concept;
                if (safeString(attributes.label).includes(term) || ("iid" in concept && safeString(concept.iid).indexOf(term) !== -1)
                    || ("value" in concept && safeString(concept.value).indexOf(term) !== -1)
                    || ("type" in concept && safeString(concept.type.label).indexOf(term) !== -1)
                    || ("label" in concept && safeString(concept.label).indexOf(term) !== -1)) {
                    matches.add(node);
                }
            }
        });
        this.searchMatches = matches;
        this.sigma.refresh();
    }

    clearSearch() {
        if (this.searchMatches == null) return;
        this.searchGraph("");
    }

    /**
     * Programmatically select an instance node — equivalent to the user
     * clicking it: highlight ring, neighbor fade, Inspector update. For
     * entity/relation nodes we match by IID; for attributes we match by
     * (typeLabel, value). No-op if the node isn't in the graph yet.
     */
    selectInstance(kind: "entity" | "relation" | "attribute", typeLabel: string, instanceId: string): void {
        const nodeKey = this.findInstanceNode(kind, typeLabel, instanceId);
        if (nodeKey == null) return;
        this.interactionHandler.selectNode(nodeKey);
    }

    /**
     * Focus an instance even when the panel is in type-selection mode — used
     * by the context-menu / inspector "load connections" actions to make the
     * just-touched instance the highlight focus regardless of the current
     * selection mode. No-op if the instance isn't in the graph.
     */
    focusInstance(kind: "entity" | "relation" | "attribute", typeLabel: string, instanceId: string): void {
        const nodeKey = this.findInstanceNode(kind, typeLabel, instanceId);
        if (nodeKey == null) return;
        this.interactionHandler.focusInstance(nodeKey);
    }

    /**
     * Highlight every instance of `typeLabel` — the type-scope counterpart to
     * `focusInstance`. Used after a context-menu "every '<type>'" load so the
     * highlight spans all instances the connections were loaded for. Resolves a
     * representative node (the given instance) to read the type from. No-op if
     * that instance isn't in the graph.
     */
    focusType(kind: "entity" | "relation" | "attribute", typeLabel: string, instanceId: string): void {
        const nodeKey = this.findInstanceNode(kind, typeLabel, instanceId);
        if (nodeKey == null) return;
        this.interactionHandler.focusType(nodeKey);
    }

    /** Whether a node is currently selected (drives whether a context-menu
     *  load should preserve the panel's selection or take focus itself). */
    get hasActiveSelection(): boolean {
        return this.interactionHandler.state.selectedNode != null
            || this.interactionHandler.selectedTypeLabel != null;
    }

    /** Recompute the highlight set against the current selection — lights up
     *  any newly-loaded neighbours without changing what the panel inspects. */
    refreshHighlight(): void {
        this.interactionHandler.recomputeHighlightSet();
    }

    /**
     * Set the secondary highlight anchors by instance identity (kind +
     * typeLabel + iid/value) — used by the Inspector to keep every step in
     * its breadcrumb trail visually lit alongside the current selection.
     * Entries that don't map to a graph node are silently dropped.
     */
    setHighlightAnchorsByInstance(specs: { kind: "entity" | "relation" | "attribute"; typeLabel: string; instanceId: string }[]): void {
        const keys = new Set<string>();
        for (const spec of specs) {
            const key = this.findInstanceNode(spec.kind, spec.typeLabel, spec.instanceId);
            if (key != null) keys.add(key);
        }
        this.interactionHandler.setSecondaryAnchors(keys);
    }

    /**
     * Pan + zoom the camera to enclose the current selection (selected node +
     * its highlighted neighbors). No-op if nothing is selected. Mirrors the
     * bbox-fitting math of `focusSearchMatches`.
     */
    focusSelection(): void {
        const handler = this.interactionHandler;
        const selectedNode = handler.state.selectedNode;
        if (selectedNode == null) return;

        const { width, height } = this.sigma.getDimensions();
        if (width === 0 || height === 0) return;

        const nodes = new Set<string>([selectedNode]);
        handler.state.selectedNeighbors?.forEach(n => nodes.add(n));

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        nodes.forEach(node => {
            try {
                const attrs = this.graph.getNodeAttributes(node);
                if (attrs.x == null || attrs.y == null) return;
                minX = Math.min(minX, attrs.x);
                maxX = Math.max(maxX, attrs.x);
                minY = Math.min(minY, attrs.y);
                maxY = Math.max(maxY, attrs.y);
            } catch { /* missing metadata mid-mutation */ }
        });
        if (!isFinite(minX)) return;

        const graphWidth = maxX - minX || 1;
        const graphHeight = maxY - minY || 1;
        const padding = 1.3;
        const rawRatio = Math.max(graphWidth / width, graphHeight / height) * padding;
        const ratio = Math.max(Math.min(rawRatio, 20), 1);

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const bbox = this.sigma.getCustomBBox() || this.sigma.getBBox();
        const x = (centerX - bbox.x[0]) / (bbox.x[1] - bbox.x[0]) || 0.5;
        const y = (centerY - bbox.y[0]) / (bbox.y[1] - bbox.y[0]) || 0.5;

        // Focus is establishing a new framing — drop any prior world pin so
        // the next onTick doesn't snap us back somewhere else.
        this.autoZoomEnabled = false;
        this.pinnedCameraWorld = null;
        this.settingCameraProgrammatically = true;
        this.sigma.getCamera().setState({ x, y, ratio, angle: 0 });
        this.settingCameraProgrammatically = false;
    }

    /**
     * Explorer "Reveal in graph": mark the given nodes with secondary carets and
     * pan (never zoom) only as far as needed to bring them into view. The
     * inspected node, primary caret and selection are unchanged.
     */
    revealNodes(nodeKeys: string[]): void {
        const keys = nodeKeys.filter(key => this.graph.hasNode(key) && !this.graph.getNodeAttribute(key, "viewHidden"));
        if (!keys.length) return;
        this.layout.stop(); this.freezeViewport(); this.stopCameraAnimation();
        this.correspondenceNodes = new Set(keys);
        this.sigma.refresh();
        this.followNavigation(keys);
    }

    /** Resolve the graph node key for an instance (entity/relation by IID,
     *  attribute by type+value), or null if it isn't in the graph. */
    instanceNodeKey(kind: "entity" | "relation" | "attribute", typeLabel: string, instanceId: string): string | null {
        return this.findInstanceNode(kind, typeLabel, instanceId);
    }

    /** View-only flags live with the result graph, surviving docking and tab switches. */
    setNodeAppearance(node: string, flag: "viewHidden" | "viewDimmed", enabled: boolean): void {
        if (!this.graph.hasNode(node)) return;
        this.graph.setNodeAttribute(node, flag, enabled);
        this.sigma.refresh();
    }

    get hasAppearanceOverrides(): boolean {
        return this.graph.someNode((_, attrs) => !!(attrs["viewHidden"] || attrs["viewDimmed"]));
    }

    restoreNodeAppearance(): void {
        this.graph.forEachNode((node, attrs) => {
            if (attrs["viewHidden"]) this.graph.removeNodeAttribute(node, "viewHidden");
            if (attrs["viewDimmed"]) this.graph.removeNodeAttribute(node, "viewDimmed");
        });
        this.sigma.refresh();
    }

    /** Resolve a graph node by entity/relation IID without needing its kind —
     *  used to reveal a role-player whose kind isn't known at the call site. */
    nodeKeyByIid(iid: string): string | null {
        let found: string | null = null;
        this.graph.nodes().forEach(node => {
            if (found != null) return;
            try {
                const concept = this.graph.getNodeAttributes(node)?.["metadata"]?.concept as any;
                if ((concept?.kind === "entity" || concept?.kind === "relation") && concept.iid === iid) {
                    found = node;
                }
            } catch { /* missing metadata mid-mutation */ }
        });
        return found;
    }

    /** Node keys of every attribute of `attrTypeLabel` owned by the given
     *  entity/relation instance currently in the graph. */
    attributeNodeKeysOf(ownerKind: "entity" | "relation", ownerTypeLabel: string, ownerIID: string, attrTypeLabel: string): string[] {
        const ownerKey = this.findInstanceNode(ownerKind, ownerTypeLabel, ownerIID);
        if (ownerKey == null) return [];
        const out: string[] = [];
        this.graph.forEachOutNeighbor(ownerKey, (neighborKey: string) => {
            try {
                const c = this.graph.getNodeAttributes(neighborKey)?.["metadata"]?.concept as any;
                if (c?.kind === "attribute" && c.type?.label === attrTypeLabel) out.push(neighborKey);
            } catch { /* missing metadata mid-mutation */ }
        });
        return out;
    }

    // -- Unloading connections (the inverse of the context-menu "load" actions).
    //    Each drops the nodes matching the connection criteria — graphology's
    //    dropNode removes their incident edges too — then reheats so the graph
    //    settles back without them. Scoped to in-graph instances of the source
    //    type so only what that connection pulled in is removed. --

    /** Set of node keys for in-graph entity/relation instances of `typeLabel`. */
    private instanceNodesOfType(typeLabel: string): Set<string> {
        const set = new Set<string>();
        this.graph.nodes().forEach(node => {
            try {
                const c = this.graph.getNodeAttributes(node)?.["metadata"]?.concept as any;
                if ((c?.kind === "entity" || c?.kind === "relation") && c.type?.label === typeLabel) set.add(node);
            } catch { /* missing metadata mid-mutation */ }
        });
        return set;
    }

    private conceptOf(node: string): any | null {
        try { return this.graph.getNodeAttributes(node)?.["metadata"]?.concept ?? null; }
        catch { return null; }
    }

    /** Drop the given nodes (and their incident edges) and recompute the
     *  highlight set. Does NOT reheat — the caller reheats once after a batch of
     *  unloads (see the context menu's `unloadConnections`). */
    private dropNodes(nodeKeys: Iterable<string>): void {
        const keys = [...nodeKeys].filter(key => this.graph.hasNode(key));
        if (!keys.length) return;
        this.rememberContext();
        let dropped = 0;
        for (const key of keys) {
            if (this.graph.hasNode(key)) { this.graph.dropNode(key); dropped++; }
        }
        if (dropped > 0) {
            if (this.navigation.caret && !this.graph.hasNode(this.navigation.caret)) this.navigation.reset();
            const inspected = this.interactionHandler.state.selectedNode;
            if (inspected && !this.graph.hasNode(inspected)) this.interactionHandler.clearSelection();
            const removed = [...this.elementSelection.nodes].filter(key => !this.graph.hasNode(key));
            if (removed.length) this.elementSelection.set(removed, false);
            this.interactionHandler.recomputeHighlightSet();
        }
    }

    /** The source node set for an unload: every in-graph instance of the type
     *  ("type" scope) or just the one clicked instance node ("instance" scope). */
    private unloadSources(scope: "type" | "instance", typeLabel: string, kind: "entity" | "relation" | "attribute", instanceId: string): Set<string> {
        if (scope === "type") return this.instanceNodesOfType(typeLabel);
        const node = this.findInstanceNode(kind, typeLabel, instanceId);
        return node ? new Set([node]) : new Set();
    }

    /** Drop every attribute node of `attrTypeLabel` adjacent to a source node. */
    private unloadAttributeFrom(sources: Set<string>, attrTypeLabel: string): void {
        const targets = new Set<string>();
        sources.forEach(src => {
            if (!this.graph.hasNode(src)) return;
            this.graph.forEachNeighbor(src, (n: string) => {
                const c = this.conceptOf(n);
                if (c?.kind === "attribute" && c.type?.label === attrTypeLabel) targets.add(n);
            });
        });
        this.dropNodes(targets);
    }

    /** Drop every relation node of `relationTypeLabel` adjacent to a source node. */
    private unloadRelationFrom(sources: Set<string>, relationTypeLabel: string): void {
        const targets = new Set<string>();
        sources.forEach(src => {
            if (!this.graph.hasNode(src)) return;
            this.graph.forEachNeighbor(src, (n: string) => {
                const c = this.conceptOf(n);
                if (c?.kind === "relation" && c.type?.label === relationTypeLabel) targets.add(n);
            });
        });
        this.dropNodes(targets);
    }

    /** Drop the player nodes reached from a source node via a `roleShortName` edge. */
    private unloadRoleFrom(sources: Set<string>, roleShortName: string): void {
        const targets = new Set<string>();
        sources.forEach(src => {
            if (!this.graph.hasNode(src)) return;
            this.graph.forEachEdge(src, (_edge: string, attrs: any, source: string, target: string) => {
                const roleLabel = edgeDisplayLabel(attrs);
                const other = source === src ? target : source;
                if (roleLabel === roleShortName && other !== src) targets.add(other);
            });
        });
        this.dropNodes(targets);
    }

    unloadAttribute(scope: "type" | "instance", sourceKind: "entity" | "relation" | "attribute", sourceTypeLabel: string, sourceId: string, attrTypeLabel: string): void {
        this.unloadAttributeFrom(this.unloadSources(scope, sourceTypeLabel, sourceKind, sourceId), attrTypeLabel);
    }

    unloadRelation(scope: "type" | "instance", sourceKind: "entity" | "relation" | "attribute", sourceTypeLabel: string, sourceId: string, relationTypeLabel: string): void {
        this.unloadRelationFrom(this.unloadSources(scope, sourceTypeLabel, sourceKind, sourceId), relationTypeLabel);
    }

    unloadRole(scope: "type" | "instance", sourceKind: "entity" | "relation" | "attribute", sourceTypeLabel: string, sourceId: string, roleShortName: string): void {
        this.unloadRoleFrom(this.unloadSources(scope, sourceTypeLabel, sourceKind, sourceId), roleShortName);
    }

    private findInstanceNode(kind: "entity" | "relation" | "attribute", typeLabel: string, instanceId: string): string | null {
        let found: string | null = null;
        this.graph.nodes().forEach(node => {
            if (found != null) return;
            try {
                const concept = this.graph.getNodeAttributes(node)?.["metadata"]?.concept;
                if (!concept) return;
                if (kind === "attribute") {
                    if (concept.kind === "attribute"
                        && concept.type?.label === typeLabel
                        && String(concept.value) === instanceId) {
                        found = node;
                    }
                } else if (concept.kind === kind && concept.iid === instanceId) {
                    found = node;
                }
            } catch { /* missing metadata mid-mutation */ }
        });
        return found;
    }

    finderEntries(): GraphFinderEntry[] {
        const entries: GraphFinderEntry[] = [];
        this.graph.forEachNode((key, attrs) => {
            const concept = attrs.metadata?.concept;
            if (!concept || attrs.viewHidden || !Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) return;
            const typeLabel = "type" in concept ? concept.type.label : "label" in concept ? concept.label : "";
            const iid = "iid" in concept ? concept.iid : "";
            const attributes = iid ? [...(this.displayAttributes.get(iid)?.entries() ?? [])] : [];
            const values = attributes.flatMap(([label, values]) => [label, ...values.map(String)]).join(" ");
            const identity = attributes.filter(([label]) => /(?:id|name|title)$/i.test(label))
                .slice(0, 2).map(([label, values]) => `${label}: ${values.map(String).join(", ")}`).join(" · ") || iid;
            entries.push({ id: `node:${key}`, label: attrs.label || typeLabel || key, detail: `${concept.kind}${typeLabel ? ` · ${typeLabel}` : ""}${identity ? ` · ${identity}` : ""}`,
                nodes: [key], text: `${attrs.label} ${typeLabel} ${iid} ${values}` });
        });
        return entries;
    }

    captureSnap(query: string, schemaMode: boolean, expansionQueries: string[] = []): GraphSnap {
        const style = this.styleService.capturePreset();
        if (style.background.type === "default" || style.background.themed) {
            style.background = { ...style.background, type: style.background.type === "default" ? "solid" : style.background.type,
                color1: this.styleService.effectiveBackgroundHex, themed: false };
        }
        const state = this.interactionHandler.state;
        return JSON.parse(JSON.stringify({
            format: "typedb-studio-graph-snap", version: 1, createdAt: new Date().toISOString(), query, schemaMode, expansionQueries,
            graph: this.graph.export(), style,
            view: { camera: this.sigma.getCamera().getState(), bbox: this.sigma.getCustomBBox() ?? this.sigma.getBBox(),
                viewport: this.sigma.getDimensions(), layoutDensity: this.layout.density, searchTerm: this.searchTerm, finderMatches: this.finderMatches ? [...this.finderMatches] : null,
                selectedNode: state.selectedNode, selectedNeighbors: [...(state.selectedNeighbors ?? [])],
                highlightedEdges: [...this.styleService.highlightedEdges], highlightedTypes: [...this.styleService.highlightedTypes],
                highlightedKinds: [...this.styleService.highlightedKinds] },
            labels: { attributes: [...this.displayAttributes].map(([key, attrs]) => [key, [...attrs]]), overrides: [...this.labelOverridesByType] },
        }));
    }

    restoreSnapView(snap: GraphSnap): void {
        this.stopCameraAnimation();
        this.navigation.reset();
        this.autoZoomEnabled = false;
        if (snap.view.layoutDensity) this.layout.setDensity(snap.view.layoutDensity);
        this.layout.stop();
        this.displayAttributes = new Map(snap.labels.attributes.map(([key, attrs]) => [key, new Map(attrs)]));
        this.labelOverridesByType = new Map(snap.labels.overrides);
        this.searchGraph(snap.view.searchTerm);
        this.finderMatches = snap.view.finderMatches ? new Set(snap.view.finderMatches) : null;
        this.interactionHandler.state.selectedNode = snap.view.selectedNode;
        this.interactionHandler.state.selectedNeighbors = new Set(snap.view.selectedNeighbors);
        this.styleService.highlightedEdges.clear();
        this.styleService.highlightedTypes.clear();
        this.styleService.highlightedKinds.clear();
        snap.view.highlightedEdges.forEach(tag => this.styleService.highlightedEdges.add(tag));
        snap.view.highlightedTypes.forEach(tag => this.styleService.highlightedTypes.add(tag));
        snap.view.highlightedKinds.forEach(tag => this.styleService.highlightedKinds.add(tag as any));
        // Snapshots restore graph state; appearance belongs to the current theme.
        this.applyStyleUpdate();
        this.applyEdgeStyleUpdate();
        this.applyEdgeCurvature();
        this.sigma.setCustomBBox(snap.view.bbox);
        this.sigma.refresh();
        this.sigma.getCamera().setState(snap.view.camera);
    }

    savedNodeAttributes(key: string): [string, unknown[]][] {
        const concept = this.graph.getNodeAttribute(key, "metadata").concept;
        const id = "iid" in concept ? concept.iid : undefined;
        return id ? [...(this.displayAttributes.get(id) ?? [])] : [];
    }

    focusHighlightedNodes(): void {
        const keys = this.highlightedNodeKeys();
        if (this.elementSelection.active) {
            for (const key of keys) this.setNodeAppearance(key, "viewHidden", false);
        }
        this.layout.stop(); this.freezeViewport();
        this.followNavigation(keys, true);
    }

    /** The same effective set for Enter, exact selection edits, and isolation. */
    highlightedNodeKeys(): string[] {
        if (this.elementSelection.active) return [...this.elementSelection.nodes].filter(key => this.graph.hasNode(key));
        const reducer = this.sigma.getSetting("nodeReducer")!;
        return this.graph.nodes().filter(key => {
            const data = reducer(key, this.graph.getNodeAttributes(key));
            return !data.hidden && (data.zIndex ?? 0) > 0;
        });
    }

    isNodeInSelection(key: string): boolean {
        return this.elementSelection.active ? this.elementSelection.nodes.has(key) : this.highlightedNodeKeys().includes(key);
    }

    toggleNodeSelection(key: string): void {
        this.elementSelection.toggleSingle(key, this.highlightedNodeKeys());
    }

    get hasWorkingContext(): boolean { return !!this.graph.getAttribute("workingContext"); }

    private rememberContext(): void {
        this.layout.stop();
        rememberWorkingContext(this.graph, { camera: this.sigma.getCamera().getState(),
            bbox: this.sigma.getCustomBBox() ?? this.sigma.getBBox() });
    }

    /** Only these nodes and their induced edges participate in the new force layout. */
    isolateSelection(): void {
        const keys = this.highlightedNodeKeys();
        if (!keys.length) return;
        this.rememberContext();
        const keep = new Set(keys);
        this.dropNodes(this.graph.nodes().filter(key => !keep.has(key)));
        for (const key of keys) this.setNodeAppearance(key, "viewHidden", false);
        this.elementSelection.replace(keys);
        this.reLayout();
    }

    /** Removing loaded data is a view edit, never a database deletion or an automatic layout. */
    removeFromGraph(key: string): void {
        if (!this.graph.hasNode(key)) return;
        this.rememberContext();
        this.freezeViewport();
        this.dropNodes([key]);
        this.sigma.refresh();
    }

    restoreContext(): void {
        if (!this.hasWorkingContext) return;
        this.stopCameraAnimation();
        this.layout.stop();
        this.autoZoomEnabled = false;
        this.pinnedCameraWorld = null;
        const context = restoreWorkingContext(this.graph)!;
        this.layout.forgetSettled();
        this.applyStyleUpdate();
        this.applyEdgeStyleUpdate();
        refreshInstanceLabels(this.graph, this.displayAttributes, this.labelOverridesByType);
        this.interactionHandler.recomputeHighlightSet();
        this.sigma.setCustomBBox(context.bbox);
        this.sigma.refresh();
        this.sigma.getCamera().setState(context.camera);
    }

    focusSearchMatches(): void {
        this.focusNodesSmoothly([...(this.searchMatches ?? [])]);
    }

    /** Fit normalized Sigma coordinates, including non-square graph bounds. */
    focusNodesSmoothly(keys: string[]): void {
        if (!keys.length) return;
        // Freeze the layout and normalization while framing: moving bounds during
        // camera animation otherwise shift the selected nodes out of the viewport.
        this.layout.stop();
        this.freezeViewport();
        this.sigma.refresh();
        const points = keys.filter(key => this.graph.hasNode(key) && !this.graph.getNodeAttribute(key, "viewHidden"))
            .map(key => this.sigma.getNodeDisplayData(key)).filter(point => !!point);
        if (!points.length) return;
        const { width, height } = this.sigma.getDimensions();
        if (!width || !height) return;
        const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
        const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
        const x = (minX + maxX) / 2, y = (minY + maxY) / 2;
        const cameraState = { x, y, ratio: 1, angle: 0 };
        const start = this.sigma.framedGraphToViewport({ x: minX, y: minY }, { cameraState });
        const end = this.sigma.framedGraphToViewport({ x: maxX, y: maxY }, { cameraState });
        const ratio = Math.max(1, Math.abs(end.x - start.x) / Math.max(1, width - 140),
            Math.abs(end.y - start.y) / Math.max(1, height - 140));
        this.autoZoomEnabled = false;
        this.pinnedCameraWorld = null;
        this.sigma.getCamera().animate({ x, y, ratio, angle: 0 }, {
            duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300,
        });
    }

    applyStructureMode(): void {
        this.syncStyles();
        this.graph.nodes().forEach(nodeKey => {
            const attrs = this.graph.getNodeAttributes(nodeKey);
            const concept = attrs.metadata.concept;
            const style = this.styleService.resolveNodeStyle(concept.kind as any, getTypeLabel(concept as any));
            const degree = this.graph.degree(nodeKey);
            const w = style.width + Math.min(degree * 2, style.width * 4);
            const h = style.height + Math.min(degree * 2, style.height * 4);
            this.graph.setNodeAttribute(nodeKey, "type", style.shape);
            this.graph.setNodeAttribute(nodeKey, "color", style.fillColor);
            this.graph.setNodeAttribute(nodeKey, "borderColor", style.color);
            this.graph.setNodeAttribute(nodeKey, "width", w);
            this.graph.setNodeAttribute(nodeKey, "height", h);
            this.graph.setNodeAttribute(nodeKey, "size", Math.max(w, h));
        });
        this.sigma.refresh();
    }

    restoreLabels(): void {
        this.syncStyles();
        const useDegreeScaling = this.styleService.degreeScaling;
        this.graph.nodes().forEach(nodeKey => {
            const attrs = this.graph.getNodeAttributes(nodeKey);
            const concept = attrs.metadata.concept as DataVertex;
            const style = this.styleService.resolveNodeStyle(concept.kind as any, getTypeLabel(concept as any));
            this.graph.setNodeAttribute(nodeKey, "label", this.styleParams.vertexDefaultLabel(concept));
            this.graph.setNodeAttribute(nodeKey, "type", style.shape);
            this.graph.setNodeAttribute(nodeKey, "color", style.fillColor);
            this.graph.setNodeAttribute(nodeKey, "borderColor", style.color);
            if (useDegreeScaling) {
                const degree = this.graph.degree(nodeKey);
                const w = style.width + Math.min(degree * 2, style.width * 4);
                const h = style.height + Math.min(degree * 2, style.height * 4);
                this.graph.setNodeAttribute(nodeKey, "width", w);
                this.graph.setNodeAttribute(nodeKey, "height", h);
                this.graph.setNodeAttribute(nodeKey, "size", Math.max(w, h));
            } else {
                this.graph.setNodeAttribute(nodeKey, "width", style.width);
                this.graph.setNodeAttribute(nodeKey, "height", style.height);
                this.graph.setNodeAttribute(nodeKey, "size", Math.max(style.width, style.height));
            }
        });
        this.graph.edges().forEach(edgeKey => {
            const attrs = this.graph.getEdgeAttributes(edgeKey);
            this.graph.setEdgeAttribute(edgeKey, "label", edgeDisplayLabel(attrs));
        });
        // The loop above resets every node to its basic type label; re-run the
        // heuristic so entity/relation instances keep their enriched labels.
        refreshInstanceLabels(this.graph, this.displayAttributes, this.labelOverridesByType);
        this.sigma.refresh();
    }

    colorEdgesByConstraintIndex(reset: boolean): void {
        _colorEdgesByConstraintIndex(this.graph, this.interactionHandler.styleParams, reset);
    }

    colorQuery(queryString: string, queryStructure: AnalyzedPipelineBackCompat): string {
        return _colorQuery(queryString, queryStructure);
    }

    get isLayoutRunning(): boolean {
        return this.layout.isRunning;
    }

    stopLayout(): void {
        this.layout.stop();
    }

    /**
     * Set the graph's node-spacing density (spacious / default / compact),
     * which retunes the layout's centering gravity and reheats. The camera is
     * deliberately left untouched — no auto-zoom and no recenter — so the
     * user's current view stays fixed while the nodes re-space.
     */
    setLayoutDensity(mode: LayoutDensity): void {
        this.autoZoomEnabled = false;
        this.layout.setDensity(mode);
    }

    /** The currently-applied node-spacing density (for the controls' menu). */
    get layoutDensity(): LayoutDensity {
        return this.layout.density;
    }

    /**
     * Render the current graph into an offscreen Sigma instance
     * and composite all of its canvas layers (WebGL nodes/edges + 2D labels) into a single
     * PNG blob.
     *
     * - "currentView": preserves the live viewport dimensions, camera and graph bounds.
     * - "wholeGraph": fits every node, also at 1 graph unit = 1 pixel, with padding for node radii.
     *
     * Throws if the graph has no nodes. Dimensions are capped at MAX_EXPORT_DIMENSION per
     * side to stay within browser canvas limits.
     */
    async exportPng(mode: GraphPngExportMode, caption?: { title: string; comment: string }): Promise<Blob> {
        if (this.graph.order === 0) throw new Error("Graph is empty");

        let width: number;
        let height: number;
        let cameraState: { x: number; y: number; ratio: number; angle: number };

        if (mode === "wholeGraph") {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            let maxNodeRadius = 0;
            this.graph.nodes().forEach(n => {
                const a = this.graph.getNodeAttributes(n);
                minX = Math.min(minX, a.x);
                maxX = Math.max(maxX, a.x);
                minY = Math.min(minY, a.y);
                maxY = Math.max(maxY, a.y);
                const w = (a as any).width ?? a.size ?? 0;
                const h = (a as any).height ?? a.size ?? 0;
                maxNodeRadius = Math.max(maxNodeRadius, Math.max(w, h) / 2);
            });
            const padding = Math.ceil(maxNodeRadius + 32);
            width = Math.max(1, Math.ceil(maxX - minX) + 2 * padding);
            height = Math.max(1, Math.ceil(maxY - minY) + 2 * padding);
            cameraState = { x: 0.5, y: 0.5, ratio: 1, angle: 0 };
        } else {
            const liveCam = this.sigma.getCamera().getState();
            const liveDims = this.sigma.getDimensions();
            width = Math.max(1, Math.ceil(liveDims.width));
            height = Math.max(1, Math.ceil(liveDims.height));
            cameraState = { ...liveCam };
        }

        // Clamp to browser canvas limits, preserving aspect ratio.
        const scale = Math.min(1, MAX_EXPORT_DIMENSION / Math.max(width, height));
        if (scale < 1) {
            width = Math.max(1, Math.floor(width * scale));
            height = Math.max(1, Math.floor(height * scale));
            if (mode === "wholeGraph") cameraState = { ...cameraState, ratio: 1 / scale };
        }

        const bgHex = this.styleService.effectiveBackgroundHex;
        const liveNodeReducer = this.sigma.getSetting("nodeReducer");
        const liveEdgeReducer = this.sigma.getSetting("edgeReducer");

        const container = document.createElement("div");
        container.style.position = "fixed";
        container.style.left = "-99999px";
        container.style.top = "0";
        container.style.width = `${width}px`;
        container.style.height = `${height}px`;
        container.style.visibility = "hidden";
        document.body.appendChild(container);

        let exportSigma: Sigma | null = null;
        try {
            exportSigma = createSigmaRenderer(container, defaultSigmaSettings as any, this.graph);
            if (liveNodeReducer) exportSigma.setSetting("nodeReducer", liveNodeReducer);
            if (liveEdgeReducer) exportSigma.setSetting("edgeReducer", liveEdgeReducer);
            // For currentView, propagate the live sigma's effective bbox so that the
            // normalised camera (x, y) coords resolve to the same graph coordinates in
            // both sigmas. For wholeGraph, let the export sigma auto-compute its bbox
            // from current node positions so (0.5, 0.5) lands on the actual graph center.
            if (mode === "currentView") {
                const liveBBox = this.sigma.getCustomBBox() ?? this.sigma.getBBox();
                exportSigma.setCustomBBox(liveBBox);
            }
            exportSigma.getCamera().setState(cameraState);

            return await new Promise<Blob>((resolve, reject) => {
                const sigma = exportSigma!;
                const onRendered = () => {
                    sigma.removeListener("afterRender", onRendered);
                    try {
                        // Sigma sizes its internal canvases at (cssDimensions × devicePixelRatio)
                        // physical pixels. Match the final canvas to physical pixel dimensions
                        // so drawImage copies 1:1 — otherwise we'd clip the source on hi-DPI displays.
                        const sourceCanvas = container.querySelector("canvas") as HTMLCanvasElement | null;
                        const physW = sourceCanvas?.width ?? width;
                        const physH = sourceCanvas?.height ?? height;
                        const finalCanvas = document.createElement("canvas");
                        finalCanvas.width = physW;
                        finalCanvas.height = physH;
                        const ctx = finalCanvas.getContext("2d");
                        if (!ctx) throw new Error("Could not create 2D context for PNG export");
                        ctx.fillStyle = bgHex;
                        ctx.fillRect(0, 0, physW, physH);
                        container.querySelectorAll("canvas").forEach(c => ctx.drawImage(c, 0, 0));
                        if (caption?.title || caption?.comment) drawExportCaption(ctx, caption, physW / width, width, bgHex);
                        finalCanvas.toBlob(blob => {
                            if (blob) resolve(blob);
                            else reject(new Error("Canvas.toBlob returned null"));
                        }, "image/png");
                    } catch (err) {
                        reject(err);
                    }
                };
                sigma.on("afterRender", onRendered);
                sigma.refresh();
            });
        } finally {
            if (exportSigma) {
                container.querySelectorAll("canvas").forEach(c => {
                    const gl = (c as HTMLCanvasElement).getContext("webgl2") || (c as HTMLCanvasElement).getContext("webgl");
                    if (gl) gl.getExtension("WEBGL_lose_context")?.loseContext();
                });
                exportSigma.kill();
            }
            container.parentNode?.removeChild(container);
        }
    }

    private applyBackground(): void {
        const container = this.sigma.getContainer();
        const bg = this.styleService.background;
        const css = buildBackgroundCSS(bg);
        container.style.backgroundColor = css.color;
        container.style.backgroundImage = css.image;
        container.style.backgroundSize = css.size;
        if (bg.type === "party") {
            container.style.setProperty("--party-color1", bg.color1);
            container.style.setProperty("--party-color2", bg.color2);
            container.classList.add("party-background");
        } else {
            container.style.removeProperty("--party-color1");
            container.style.removeProperty("--party-color2");
            container.classList.remove("party-background");
        }
    }

    destroy() {
        this.stylesSub.unsubscribe();
        this.contextGuardCleanups.forEach(fn => fn());
        this.contextGuardCleanups = [];
        // Stop the layout sim and detach our onTick before killing sigma —
        // otherwise the rAF tick keeps mutating the graph and calling
        // centerCamera() on the dead sigma, which schedules renders that
        // crash inside process() (empty nodePrograms / nodeDataCache).
        this.layout.stop();
        this.layout.onTick = null;
        if (this.cameraUpdatedListener) {
            this.sigma.getCamera().removeListener("updated", this.cameraUpdatedListener);
            this.cameraUpdatedListener = null;
        }
        // Force-lose WebGL contexts before killing sigma so the browser
        // reclaims context slots immediately instead of waiting for GC.
        const container = this.sigma.getContainer();
        container.querySelectorAll("canvas").forEach(canvas => {
            const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
            if (gl) gl.getExtension("WEBGL_lose_context")?.loseContext();
        });
        this.sigma.kill();
    }
}
