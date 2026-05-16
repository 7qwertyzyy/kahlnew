import type mapboxgl from "mapbox-gl";

export const SOURCE_ROUTE = "route-source";
export const SOURCE_CONSTRUCTIONS = "constructions-source";
export const SOURCE_RESTRICTIONS = "restrictions-source";

export const LAYER_ROUTE = "route-layer";
export const LAYER_ROUTE_OUTLINE = "route-outline-layer";
export const LAYER_CONSTRUCTION_LINES = "construction-lines-layer";
export const LAYER_CONSTRUCTION_POINTS = "construction-points-layer";
export const LAYER_RESTRICTION_RED = "restriction-red-layer";
export const LAYER_RESTRICTION_YELLOW = "restriction-yellow-layer";

export function addRouteLayers(map: mapboxgl.Map) {
  if (!map.getSource(SOURCE_ROUTE)) {
    map.addSource(SOURCE_ROUTE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }

  if (!map.getLayer(LAYER_ROUTE_OUTLINE)) {
    map.addLayer({
      id: LAYER_ROUTE_OUTLINE,
      type: "line",
      source: SOURCE_ROUTE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#1e40af",
        "line-width": 10,
        "line-opacity": 0.4,
      },
    });
  }

  if (!map.getLayer(LAYER_ROUTE)) {
    map.addLayer({
      id: LAYER_ROUTE,
      type: "line",
      source: SOURCE_ROUTE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#3b82f6",
        "line-width": 5,
      },
    });
  }
}

export function addConstructionLayers(map: mapboxgl.Map) {
  if (!map.getSource(SOURCE_CONSTRUCTIONS)) {
    map.addSource(SOURCE_CONSTRUCTIONS, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }

  if (!map.getLayer(LAYER_CONSTRUCTION_LINES)) {
    map.addLayer(
      {
        id: LAYER_CONSTRUCTION_LINES,
        type: "line",
        source: SOURCE_CONSTRUCTIONS,
        filter: ["==", ["get", "featureType"], "line"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#f97316",
          "line-width": 4,
          "line-opacity": 0.85,
        },
      },
      LAYER_ROUTE_OUTLINE
    );
  }

  if (!map.getLayer(LAYER_CONSTRUCTION_POINTS)) {
    map.addLayer(
      {
        id: LAYER_CONSTRUCTION_POINTS,
        type: "circle",
        source: SOURCE_CONSTRUCTIONS,
        filter: ["==", ["get", "featureType"], "point"],
        paint: {
          "circle-color": "#3b82f6",
          "circle-radius": 7,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
          "circle-opacity": 0.9,
        },
      },
      LAYER_ROUTE_OUTLINE
    );
  }
}

export function addRestrictionLayers(map: mapboxgl.Map) {
  if (!map.getSource(SOURCE_RESTRICTIONS)) {
    map.addSource(SOURCE_RESTRICTIONS, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }

  if (!map.getLayer(LAYER_RESTRICTION_YELLOW)) {
    map.addLayer({
      id: LAYER_RESTRICTION_YELLOW,
      type: "line",
      source: SOURCE_RESTRICTIONS,
      filter: ["==", ["get", "severity"], "warning"],
      layout: { "line-cap": "round" },
      paint: {
        "line-color": "#eab308",
        "line-width": 5,
        "line-gap-width": 2,
      },
    });
  }

  if (!map.getLayer(LAYER_RESTRICTION_RED)) {
    map.addLayer({
      id: LAYER_RESTRICTION_RED,
      type: "line",
      source: SOURCE_RESTRICTIONS,
      filter: ["==", ["get", "severity"], "danger"],
      layout: { "line-cap": "round" },
      paint: {
        "line-color": "#ef4444",
        "line-width": 5,
        "line-gap-width": 2,
      },
    });
  }
}
