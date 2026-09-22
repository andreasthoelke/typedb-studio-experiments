export interface Point { x: number; y: number }
export interface ArrowNode extends Point { width: number; height: number; type: string }

/** Same shape boundaries as the pinned node shaders, in viewport pixels. */
export function insideArrowNode(point: Point, node: ArrowNode): boolean {
    const w = Math.max(node.width, .01), h = Math.max(node.height, .01);
    const x = Math.abs(point.x - node.x), y = Math.abs(point.y - node.y);
    if (node.type === 'ellipse') return (x / w) ** 2 + (y / h) ** 2 <= 1;
    if (node.type === 'diamond') {
        const dot = w * w + h * h;
        const t = Math.max(-1, Math.min(1, ((w - 2 * x) * w - (h - 2 * y) * h) / dot));
        const dist = Math.hypot(x - .5 * w * (1 - t), y - .5 * h * (1 + t));
        return (x * h + y * w <= w * h ? -dist : dist) <= .32 * h;
    }
    if (node.type === 'hexagon') {
        let a = y, b = x;
        const d = Math.min(-.866025404 * a + .5 * b, 0);
        a -= 2 * d * -.866025404; b -= d;
        const r = .8660254 * h;
        a -= Math.max(-.577350269 * r, Math.min(.577350269 * r, a)); b -= r;
        return Math.hypot(a, b) * Math.sign(b) <= 0;
    }
    const r = .5 * h, dx = x - w + r, dy = y - h + r;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) <= r;
}

/** Locate the last boundary crossing on the actual quadratic curve, then orient
 * the tip along its tangent. This also handles straight lines (curvature = 0). */
export function graphArrow(source: ArrowNode, target: ArrowNode, curvature: number, length = 9): Point[] | null {
    const dx = target.x - source.x, dy = target.y - source.y;
    if (Math.hypot(dx, dy) < 1) return null;
    const cp = { x: (source.x + target.x) / 2 + curvature * dy,
        y: (source.y + target.y) / 2 - curvature * dx };
    const at = (t: number): Point => ({ x: (1-t)**2*source.x + 2*(1-t)*t*cp.x + t*t*target.x,
        y: (1-t)**2*source.y + 2*(1-t)*t*cp.y + t*t*target.y });
    let outside = 1;
    while (outside > 0 && insideArrowNode(at(outside), target)) outside -= 1/64;
    if (outside <= 0) return null;
    let inside = outside + 1/64;
    for (let i = 0; i < 16; i++) {
        const mid = (outside + inside) / 2;
        if (insideArrowNode(at(mid), target)) inside = mid; else outside = mid;
    }
    const tip = at(outside), tx = (1-outside)*(cp.x-source.x)+outside*(target.x-cp.x),
        ty = (1-outside)*(cp.y-source.y)+outside*(target.y-cp.y), norm = Math.hypot(tx,ty);
    if (!norm) return null;
    const ux = tx/norm, uy = ty/norm;
    // Slight clearance avoids painting over the type node's border.
    tip.x -= ux; tip.y -= uy;
    const base = { x: tip.x-length*ux, y: tip.y-length*uy };
    const triangle = [tip, { x: base.x-length*.45*uy, y: base.y+length*.45*ux },
        { x: base.x+length*.45*uy, y: base.y-length*.45*ux }];
    return triangle.some(p => insideArrowNode(p, source)) ? null : triangle;
}
