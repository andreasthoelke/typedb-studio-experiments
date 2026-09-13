import { EdgeRectangleProgram, ProgramInfo } from "sigma/rendering";
import { EdgeDisplayData, NodeDisplayData, RenderParams } from "sigma/types";
import { DASH_GLSL, lineStyleIndex } from "../../util/line-style";

/** Extend the pinned Sigma 3 programs; preserve their geometry, labels and solid picking surface. */
export function withEdgeDashes(Base: typeof EdgeRectangleProgram, curved: boolean) {
    return class DashedEdgeProgram extends Base {
        override getDefinition() {
            const definition = super.getDefinition();
            const vertexHeader = "attribute float a_lineStyle;\nvarying float v_lineStyle;\n" +
                (curved ? "" : "uniform vec2 u_dashDimensions;\nvarying float v_dashDistance;\n");
            const vertexMain = `v_lineStyle = a_lineStyle;
                ${curved ? "" : `v_dashDistance = a_positionCoef * length((u_matrix * vec3(a_positionEnd - a_positionStart, 0.0)).xy * u_dashDimensions * 0.5);`}`;
            let fragment = definition.FRAGMENT_SHADER_SOURCE;
            let distance = "v_dashDistance";
            if (curved) {
                // The upstream nearest-point calculation already determines Bezier t.
                // Reuse that t to integrate the curve's speed (Simpson approximation).
                fragment = fragment.replace("vec2 getDistanceVector", "float dashCurveT;\nvec2 getDistanceVector")
                    .replace("return mix(mix(b0, b1, t)", "dashCurveT = t;\n  return mix(mix(b0, b1, t)");
                distance = `(dashCurveT / 3.0 * (length(v_cpB-v_cpA) + 4.0*length(mix(v_cpB-v_cpA,v_cpC-v_cpB,dashCurveT*0.5)) + length(mix(v_cpB-v_cpA,v_cpC-v_cpB,dashCurveT))) / u_dashPixelRatio)`;
            }
            // Append after the upstream body, so its curve parameter is initialized.
            const end = fragment.lastIndexOf("}");
            fragment = fragment.slice(0, end) + `
                #ifndef PICKING_MODE
                if (v_lineStyle > 0.5) gl_FragColor *= dashMask(${distance}, v_lineStyle);
                #endif
            ` + fragment.slice(end);
            return {
                ...definition,
                VERTEX_SHADER_SOURCE: vertexHeader + definition.VERTEX_SHADER_SOURCE.replace("void main() {", `void main() {\n${vertexMain}`),
                FRAGMENT_SHADER_SOURCE: fragment.replace(/precision (?:highp|mediump) float;/, `precision highp float;\nvarying float v_lineStyle;\n${curved ? "uniform float u_dashPixelRatio;" : "varying float v_dashDistance;"}\n${DASH_GLSL}`),
                UNIFORMS: [...definition.UNIFORMS, curved ? "u_dashPixelRatio" : "u_dashDimensions"],
                ATTRIBUTES: [...definition.ATTRIBUTES, { name: "a_lineStyle", size: 1, type: WebGLRenderingContext.FLOAT }],
            } as unknown as ReturnType<EdgeRectangleProgram["getDefinition"]>;
        }

        override processVisibleItem(index: number, start: number, source: NodeDisplayData, target: NodeDisplayData, data: EdgeDisplayData): void {
            super.processVisibleItem(index, start, source, target, data);
            this.array[start + this.ATTRIBUTES_ITEMS_COUNT - 1] = lineStyleIndex((data as EdgeDisplayData & { lineStyle?: string }).lineStyle);
        }

        override setUniforms(params: RenderParams, info: ProgramInfo): void {
            super.setUniforms(params, info);
            if (curved) info.gl.uniform1f(info.uniformLocations["u_dashPixelRatio"], params.pixelRatio);
            else info.gl.uniform2f(info.uniformLocations["u_dashDimensions"], params.width, params.height);
        }
    };
}
