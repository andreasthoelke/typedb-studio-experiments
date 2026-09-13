import { DASH_GLSL } from "../../../util/line-style";

/** Perimeter coordinates on the node itself, so patterns rotate/pan with the outline. */
export function outlineDashGLSL(shape: string): string {
    const vertices = shape === "diamond" ? ["vec2(rx,0.0)", "vec2(0.0,ry)", "vec2(-rx,0.0)", "vec2(0.0,-ry)"]
        : shape === "hexagon" ? ["vec2(0.0,0.5)", "vec2(-0.4330127,0.25)", "vec2(-0.4330127,-0.25)", "vec2(0.0,-0.5)", "vec2(0.4330127,-0.25)", "vec2(0.4330127,0.25)"]
        : ["vec2(rx,ry)", "vec2(-rx,ry)", "vec2(-rx,-ry)", "vec2(rx,-ry)"];
    return `${DASH_GLSL}
varying float v_lineStyle;
void perimeterSegment(vec2 p, vec2 a, vec2 b, inout float offset, inout float best, inout float position) {
    vec2 d = b - a;
    float t = clamp(dot(p-a,d) / max(dot(d,d),0.00001),0.0,1.0);
    float distance = length(p-a-t*d);
    if (distance < best) { best=distance; position=offset+t*length(d); }
    offset += length(d);
}
void roundedPerimeterSegment(vec2 p, vec2 previous, vec2 a, vec2 b, float radius,
                            inout float offset, inout float best, inout float position) {
    vec2 incoming=normalize(a-previous), outgoing=normalize(b-a);
    vec2 n0=vec2(incoming.y,-incoming.x), n1=vec2(outgoing.y,-outgoing.x);
    float turn=acos(clamp(dot(n0,n1),-1.0,1.0));
    vec2 delta=p-a;
    float angle=clamp(atan(n0.x*delta.y-n0.y*delta.x,dot(n0,delta)),0.0,turn);
    vec2 direction=vec2(n0.x*cos(angle)-n0.y*sin(angle),n0.x*sin(angle)+n0.y*cos(angle));
    float distance=length(p-a-radius*direction);
    if(distance<best) { best=distance; position=offset+radius*angle; }
    offset+=radius*turn;
    perimeterSegment(p,a+radius*n1,b+radius*n1,offset,best,position);
}
float outlinePosition(vec2 p) {
    float rx=v_aspect*0.5, ry=0.5;
    ${shape === "ellipse" ? `
    // Smooth approximation of ellipse arc length; exact for circular outlines.
    float angle=atan(p.y/ry,p.x/rx)+3.14159265;
    return angle*(rx+ry)*0.5+(rx-ry)*sin(2.0*angle)*0.25;`
         : shape === "rounded-rect" ? `
    float r=min(0.25,min(rx,ry)), quadrant=rx+ry-2.0*r+1.57079633*r;
    vec2 q=abs(p);
    float position;
    if(q.x > rx-r && q.y > ry-r) position=ry-r+r*atan(q.y-ry+r,q.x-rx+r);
    else if(q.x > rx-r) position=q.y;
    else position=ry-r+1.57079633*r+rx-r-q.x;
    if(p.x<0.0) position=p.y>=0.0 ? 2.0*quadrant-position : 2.0*quadrant+position;
    else if(p.y<0.0) position=4.0*quadrant-position;
    return position;`
        : `float offset=0.0, best=10000.0, position=0.0;
    ${vertices.map((a, i) => shape === "diamond"
        ? `roundedPerimeterSegment(p,${vertices[(i+vertices.length-1)%vertices.length]},${a},${vertices[(i+1)%vertices.length]},CORNER_RADIUS,offset,best,position);`
        : `perimeterSegment(p,${a},${vertices[(i+1)%vertices.length]},offset,best,position);`).join("\n    ")}
    return position;`}
}
`;
}
