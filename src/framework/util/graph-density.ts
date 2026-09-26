/** Node-spacing density presets for the force layout (see engine/layout.ts). */
export type LayoutDensity = "airy" | "spacious" | "default" | "compact" | "dense" | "tight";

/** Densities from roomiest to tightest; Ctrl-= / Ctrl-- step along this. */
export const DENSITY_ORDER: readonly LayoutDensity[] = ["airy", "spacious", "default", "compact", "dense", "tight"];

/** The neighbouring density: "roomier" steps toward airy, "denser" toward tight.
 *  Null at either end. */
export function stepDensity(current: LayoutDensity, direction: "roomier" | "denser"): LayoutDensity | null {
    const index = DENSITY_ORDER.indexOf(current) + (direction === "roomier" ? -1 : 1);
    return DENSITY_ORDER[index] ?? null;
}
