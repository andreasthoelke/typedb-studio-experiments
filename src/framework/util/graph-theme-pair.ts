import type { CustomPreset, PartialNodeStyle } from "../../service/graph-style.service";

/** Structure is shared; colours remain authored for their own background. */
export function shareThemeStructure(source: CustomPreset, palette: CustomPreset): CustomPreset {
    const styles = (a: Record<string, PartialNodeStyle>, b: Record<string, PartialNodeStyle>) =>
        Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => {
            const { color: _, ...structure } = a[key] ?? {};
            return [key, { ...structure, ...(b[key]?.color ? { color: b[key].color } : {}) }];
        }));
    return { ...structuredClone(source), name: palette.name, description: palette.description,
        kindStyles: styles(source.kindStyles, palette.kindStyles), typeStyles: styles(source.typeStyles, palette.typeStyles),
        defaultEdgeColor: palette.defaultEdgeColor, edgeLabelColors: { ...palette.edgeLabelColors },
        background: { ...source.background, color1: palette.background.color1, color2: palette.background.color2 } };
}
export const initialThemePair: Record<"light" | "dark", CustomPreset> = {
  "light": {
    "name": "Munsell Paper 8",
    "description": "",
    "kindStyles": {
      "entity": {
        "shape": "rounded-rect",
        "width": 64,
        "height": 28,
        "color": "#984b58",
        "lineStyle": "solid"
      },
      "entityType": {
        "shape": "rounded-rect",
        "width": 64,
        "height": 28,
        "color": "#984b58",
        "lineStyle": "dotted"
      },
      "relation": {
        "shape": "diamond",
        "width": 46,
        "height": 28,
        "lineStyle": "solid",
        "color": "#26786d"
      },
      "relationType": {
        "shape": "diamond",
        "width": 38,
        "height": 17,
        "lineStyle": "dotted",
        "color": "#26786d"
      },
      "attribute": {
        "shape": "diamond",
        "width": 38,
        "height": 30,
        "color": "#846525",
        "lineStyle": "solid"
      },
      "attributeType": {
        "shape": "diamond",
        "width": 20,
        "height": 13,
        "color": "#846525",
        "lineStyle": "dotted"
      },
      "roleType": {
        "shape": "hexagon",
        "width": 37,
        "height": 23,
        "color": "#765480",
        "lineStyle": "dotted"
      },
      "value": {
        "shape": "ellipse",
        "width": 46,
        "height": 24,
        "color": "#846525",
        "lineStyle": "solid"
      },
      "unavailable": {
        "shape": "ellipse",
        "width": 32,
        "height": 24,
        "color": "#8C9DA4",
        "lineStyle": "solid"
      }
    },
    "typeStyles": {
      "mental-state": {
        "width": 82
      },
      "goal": {
        "shape": "ellipse",
        "width": 69,
        "height": 23,
        "color": "#9b7a7d"
      },
      "composition": {
        "color": "#0f9381"
      },
      "depiction-slot": {
        "color": "#289727"
      },
      "stages": {
        "color": "#057f6f"
      },
      "occurrence": {
        "width": 100,
        "height": 14,
        "color": "#917e80"
      },
      "depiction": {
        "color": "#ad7191"
      },
      "slot-def": {
        "width": 70,
        "height": 16,
        "color": "#947f78"
      },
      "take-includes": {
        "color": "#768784"
      },
      "tension": {
        "width": 76,
        "color": "#00937f"
      },
      "motivation": {
        "width": 97,
        "color": "#00574b"
      },
      "scene-take": {
        "color": "#1e9652"
      },
      "scene": {
        "width": 73,
        "height": 67
      },
      "take": {
        "width": 130,
        "height": 25
      }
    },
    "edgeLabelColors": {
      "relates": "#67747a",
      "plays": "#67747a",
      "owns": "#67747a",
      "sub!": "#67747a"
    },
    "edgeLineStyles": {},
    "defaultEdgeLineStyle": "solid",
    "edgeLineThicknesses": {},
    "defaultEdgeLineThickness": 1,
    "defaultEdgeColor": "#67747a",
    "colorEdgesByConstraint": false,
    "labelColorMode": "auto",
    "labelsVisible": true,
    "edgeLabelsVisible": true,
    "showHoverLabel": true,
    "degreeScaling": true,
    "edgesCurvedByDefault": false,
    "fillOpacity": 0.1,
    "background": {
      "type": "solid",
      "color1": "#E3E6E9",
      "color2": "#E3E6E9",
      "gradientAngle": 180,
      "themed": false
    }
  },
  "dark": {
    "name": "Ink9",
    "description": "",
    "kindStyles": {
      "entity": {
        "shape": "rounded-rect",
        "width": 64,
        "height": 28,
        "color": "#d9919d",
        "lineStyle": "solid"
      },
      "entityType": {
        "shape": "rounded-rect",
        "width": 64,
        "height": 28,
        "color": "#d9919d",
        "lineStyle": "dotted"
      },
      "relation": {
        "shape": "diamond",
        "width": 46,
        "height": 28,
        "lineStyle": "solid",
        "color": "#65bdae"
      },
      "relationType": {
        "shape": "diamond",
        "width": 38,
        "height": 17,
        "lineStyle": "dotted",
        "color": "#65bdae"
      },
      "attribute": {
        "shape": "diamond",
        "width": 38,
        "height": 30,
        "color": "#c4aa69",
        "lineStyle": "solid"
      },
      "attributeType": {
        "shape": "diamond",
        "width": 20,
        "height": 13,
        "color": "#c4aa69",
        "lineStyle": "dotted"
      },
      "roleType": {
        "shape": "hexagon",
        "width": 37,
        "height": 23,
        "color": "#bb94c5",
        "lineStyle": "dotted"
      },
      "value": {
        "shape": "ellipse",
        "width": 46,
        "height": 24,
        "color": "#c4aa69",
        "lineStyle": "solid"
      },
      "unavailable": {
        "shape": "ellipse",
        "width": 32,
        "height": 24,
        "color": "#8C9DA4",
        "lineStyle": "solid"
      }
    },
    "typeStyles": {
      "mental-state": {
        "width": 62
      },
      "goal": {
        "shape": "ellipse",
        "width": 69,
        "height": 23,
        "color": "#f2bfc4"
      },
      "composition": {
        "color": "#17dec3"
      },
      "depiction-slot": {
        "color": "#33bf31"
      },
      "stages": {
        "color": "#057f6f"
      },
      "occurrence": {
        "color": "#c72939"
      },
      "depiction": {
        "color": "#db8fb8"
      },
      "slot-def": {
        "color": "#f4a990"
      },
      "take-includes": {
        "color": "#44615d"
      },
      "tension": {
        "width": 76,
        "color": "#00c7ac"
      },
      "motivation": {
        "width": 87,
        "color": "#098675"
      },
      "scene-take": {
        "color": "#24b764"
      },
      "scene": {
        "width": 86,
        "height": 36
      },
      "take": {
        "width": 95
      }
    },
    "edgeLabelColors": {
      "relates": "#929fa5",
      "plays": "#929fa5",
      "owns": "#929fa5",
      "sub!": "#929fa5",
      "links": "#929fa5",
      "isa": "#929fa5",
      "isa!": "#929fa5"
    },
    "edgeLineStyles": {},
    "defaultEdgeLineStyle": "solid",
    "edgeLineThicknesses": {},
    "defaultEdgeLineThickness": 1,
    "defaultEdgeColor": "#929fa5",
    "colorEdgesByConstraint": false,
    "labelColorMode": "auto",
    "labelsVisible": true,
    "edgeLabelsVisible": true,
    "showHoverLabel": true,
    "degreeScaling": true,
    "edgesCurvedByDefault": false,
    "fillOpacity": 0.1,
    "background": {
      "type": "solid",
      "color1": "#050505",
      "color2": "#E3E6E9",
      "gradientAngle": 180,
      "themed": false
    }
  }
};
