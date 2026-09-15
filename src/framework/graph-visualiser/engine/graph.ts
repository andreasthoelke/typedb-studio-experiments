import type { LineStyle } from "../../util/line-style";
import { EdgeKind } from "@typedb/driver-http";
import { MultiGraph } from "graphology";
import { DataConstraintAny } from "@typedb/graph-utils";
import type { GraphSelectionSnapshot } from "../../util/graph-element-selection";
import type { GraphWorkingContext } from "../../util/graph-working-context";
import type { StudioDataVertex } from "./types";

export interface VertexMetadata {
    defaultLabel: string;
    hoverLabel: string;
    concept: StudioDataVertex;
}

export interface VertexAttributes {
    lineStyle?: LineStyle;
    /** Transient appearance within one graph result; never part of a style preset. */
    viewHidden?: boolean;
    viewDimmed?: boolean;
    label: string;
    color: string;
    borderColor: string;
    width: number;
    height: number;
    size: number;  // max(width, height) — kept for sigma internals
    type: string;
    x: number;
    y: number;
    metadata: VertexMetadata;
    highlighted: boolean;
}

export interface EdgeMetadata {
    defaultLabel?: string;
    answerIndex: number;
    dataEdge: DataConstraintAny;
}

export interface EdgeAttributes {
    lineStyle?: LineStyle;
    label: string;
    color: string;
    size: number;
    type: string;
    /** Bend amount read by the curved-edge program; larger fans parallel
     *  edges further apart. */
    curvature?: number;
    metadata: EdgeMetadata;
}

export interface GraphAttributes {
    elementSelection?: GraphSelectionSnapshot;
    workingContext?: GraphWorkingContext;
}

export type Graph = MultiGraph<VertexAttributes, EdgeAttributes, GraphAttributes>;

export const newGraph: () => Graph = () => new MultiGraph<VertexAttributes, EdgeAttributes, GraphAttributes>();

export interface GraphBuilderStructureParams {
    ignoreEdgesInvolvingLabels: Array<EdgeKind>,
}

export const defaultStructureParams: GraphBuilderStructureParams = {
    ignoreEdgesInvolvingLabels: ["isa", "sub", "relates", "plays"],
};
