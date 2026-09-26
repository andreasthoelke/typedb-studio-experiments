import Sigma from 'sigma';
import type { NodeDisplayData } from 'sigma/types';
import { graphArrow, ArrowNode } from '../../util/graph-arrow';

/** A small canvas layer preserves existing WebGL dash/curve programs and edge
 * picking. createSigmaRenderer also installs it for PNG exports. */
export function installSemanticArrows(renderer: Sigma): void {
    const canvas = renderer.createCanvas('semanticArrows', { beforeLayer: 'nodes', style: { pointerEvents: 'none' } });
    const ctx = canvas.getContext('2d')!;
    const graph = renderer.getGraph();
    const draw = () => {
        const { width, height } = renderer.getDimensions(), pixelRatio = window.devicePixelRatio || 1;
        // This layer is installed after Sigma's initial resize. Set CSS dimensions
        // as well as backing pixels; otherwise Retina scales it twice until resize.
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
        if (canvas.width !== Math.round(width * pixelRatio)) canvas.width = Math.round(width * pixelRatio);
        if (canvas.height !== Math.round(height * pixelRatio)) canvas.height = Math.round(height * pixelRatio);
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0); ctx.clearRect(0, 0, width, height);
        graph.forEachEdge((key, attrs, source, target) => {
            const tag = attrs['metadata']?.dataEdge?.tag;
            const edge = renderer.getEdgeDisplayData(key), from = renderer.getNodeDisplayData(source), to = renderer.getNodeDisplayData(target);
            if (!edge || !from || !to || edge.hidden || from.hidden || to.hidden) return;
            const roleArrow = (edge as typeof edge & { roleArrow?: string }).roleArrow;
            if (!['isa', 'isa!'].includes(tag) && !(tag === 'links' && ['relation', 'player'].includes(roleArrow ?? ''))) return;
            // GraphBuilder always stores role edges relation → player, including
            // when the player is itself a relation instance.
            const reverse = tag === 'links' && roleArrow === 'relation';
            const node = (data: NodeDisplayData & { width?: number; height?: number }): ArrowNode => ({ ...renderer.framedGraphToViewport(data),
                width: renderer.scaleSize(data['width'] ?? data.size), height: renderer.scaleSize(data['height'] ?? data.size), type: data.type });
            const triangle = graphArrow(node(reverse ? to : from), node(reverse ? from : to), (reverse ? -1 : 1) * (edge.type === 'curved' ? (edge as typeof edge & { curvature?: number }).curvature ?? .25 : 0),
                // Half the original 6–14px heads (2026-09-26, user request).
                Math.max(3, Math.min(7, renderer.scaleSize(edge.size) * 2 + 2.5)));
            if (!triangle) return;
            ctx.fillStyle = edge.color; ctx.beginPath(); ctx.moveTo(triangle[0].x, triangle[0].y);
            ctx.lineTo(triangle[1].x, triangle[1].y); ctx.lineTo(triangle[2].x, triangle[2].y); ctx.closePath(); ctx.fill();
        });
    };
    renderer.on('afterRender', draw);
    renderer.on('kill', () => renderer.off('afterRender', draw));
}
