export const LINE_STYLES = ["solid", "dotted", "short-dash", "long-dash", "dash-dot"] as const;
export type LineStyle = typeof LINE_STYLES[number];
export const LINE_STYLE_OPTIONS = [
    { value: "solid", label: "Solid" }, { value: "dotted", label: "Dotted" },
    { value: "short-dash", label: "Short dash" }, { value: "long-dash", label: "Long dash" },
    { value: "dash-dot", label: "Dash-dot" },
] as const;
export function lineStyleIndex(style: unknown): number {
    return Math.max(0, LINE_STYLES.indexOf(style as LineStyle));
}

/** Distances in CSS pixels. Shared by all WebGL outline/edge programs. */
export const DASH_GLSL = `
float dashMask(float distance, float style) {
    if (style < 0.5) return 1.0;
    float period = style < 1.5 ? 5.0 : style < 2.5 ? 10.0 : style < 3.5 ? 18.0 : 17.0;
    float ink = style < 1.5 ? 1.5 : style < 2.5 ? 5.0 : style < 3.5 ? 12.0 : 8.0;
    float p = mod(distance, period);
    float mask = 1.0 - smoothstep(ink - 0.4, ink + 0.4, p);
    if (style > 3.5) mask = max(mask, smoothstep(11.6, 12.4, p) * (1.0 - smoothstep(13.6, 14.4, p)));
    return mask;
}
`;
