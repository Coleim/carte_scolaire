#!/usr/bin/env node
/**
 * Script de rafraîchissement manuel des données statiques.
 *
 * Ce projet n'effectue aucun appel réseau au runtime (pages statiques).
 * Toutes les couches de secteurs scolaires sont pré-téléchargées ici, une
 * fois, et committées dans data/. Relance ce script quand tu veux mettre
 * à jour les données (pas d'automatisation/cron prévue volontairement).
 *
 * Usage: node scripts/refresh-sources.mjs
 */

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

// ---------------------------------------------------------------------------
// 1. Sources "simples" (un fichier GeoJSON = une source dans sources.json)
// ---------------------------------------------------------------------------
const SIMPLE_SOURCES = [
  {
    id: "paris-colleges-placeholder", // ignoré, Paris est traité à part plus bas
    skip: true,
  },
  {
    id: "isere-colleges",
    url: "https://opendata.isere.fr/api/explore/v2.1/catalog/datasets/aires-de-rattachements-des-colleges-en-isere/exports/geojson",
  },
  {
    id: "haute-garonne-colleges",
    url: "https://data.haute-garonne.fr/api/explore/v2.1/catalog/datasets/sectorisation-colleges-classes-6eme/exports/geojson",
  },
  {
    id: "aude-colleges",
    url: "https://opendata.aude.fr/api/explore/v2.1/catalog/datasets/cd11_secteurs_colleges/exports/geojson",
  },
  {
    id: "loire-atlantique-colleges",
    url: "https://data.loire-atlantique.fr/api/explore/v2.1/catalog/datasets/224400028_carte-scolaire-des-colleges-publics-de-loire-atlantique/exports/geojson",
  },
  {
    id: "maine-et-loire-colleges",
    url: "https://data.maine-et-loire.fr/api/explore/v2.1/catalog/datasets/224900019_sectorisation-colleges-publics-maine-et-loire/exports/geojson",
  },
  {
    id: "hautes-pyrenees-colleges",
    url: "https://opendata.ha-py.fr/api/explore/v2.1/catalog/datasets/departementdeshautespyrenees_sectorisation_colleges/exports/geojson",
  },
  {
    id: "hauts-de-seine-colleges",
    url: "https://opendata.hauts-de-seine.fr/api/explore/v2.1/catalog/datasets/fr-229200506-carte-scolaire-colleges-publics-secteurs/exports/geojson",
  },
  {
    id: "bordeaux-ecoles",
    url: "https://datahub.bordeaux-metropole.fr/api/explore/v2.1/catalog/datasets/se_ecole_s/exports/geojson",
  },
  {
    id: "clermont-ecoles",
    url: "https://opendata.clermontmetropole.eu/api/explore/v2.1/catalog/datasets/secteurs-scolaires-des-ecoles-vcf/exports/geojson",
  },
  {
    id: "orleans-maternelles",
    url: "https://data.orleans-metropole.fr/api/explore/v2.1/catalog/datasets/administratifscol_sect_mater/exports/geojson",
  },
  {
    id: "orleans-elementaires",
    url: "https://data.orleans-metropole.fr/api/explore/v2.1/catalog/datasets/administratifscol_sect_elem/exports/geojson",
  },
  {
    id: "saint-nazaire-ecoles",
    url: "https://data.agglo-carene.fr/api/explore/v2.1/catalog/datasets/214401846_educ_perimetre_ecole_prox_184/exports/geojson",
  },
  {
    id: "issy-ecoles",
    url: "https://data.issy.com/api/explore/v2.1/catalog/datasets/ecoles-maternelles-secteurs-scolaires-a-issy-les-moulineaux0/exports/geojson",
  },
];

// ---------------------------------------------------------------------------
// 2. Paris : découpage par arrondissement via jointure spatiale
// ---------------------------------------------------------------------------
const PARIS_ARRONDISSEMENTS_URL =
  "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/arrondissements/exports/geojson";

const PARIS_DATASETS = [
  {
    key: "colleges",
    url: "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/secteurs-scolaires-colleges/exports/geojson",
  },
  {
    key: "maternelles",
    url: "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/secteurs-scolaires-maternelles/exports/geojson",
  },
  {
    key: "elementaires",
    url: "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/secteurs-scolaires-ecoles-elementaires/exports/geojson",
  },
];

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/geo+json, application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Simplification géométrique (Douglas-Peucker) + arrondi des coordonnées.
// Les données sources contiennent des polygones à la précision cadastrale
// (plusieurs milliers de points par secteur), inutile pour un affichage web
// à l'échelle départementale/régionale : ça gonfle les fichiers sans gain
// visuel. On simplifie pour des fichiers statiques légers et rapides.
// ---------------------------------------------------------------------------
const SIMPLIFY_TOLERANCE_DEG = 0.0002; // ~20m, bon compromis taille/fidélité
const COORD_DECIMALS = 6; // ~0.1m de précision, largement suffisant

function perpendicularDistance(p, a, b) {
  const [x, y] = p, [x1, y1] = a, [x2, y2] = b;
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(x - cx, y - cy);
}

function douglasPeucker(points, tolerance) {
  if (points.length < 3) return points;
  let maxDist = 0;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist > tolerance) {
    const left = douglasPeucker(points.slice(0, idx + 1), tolerance);
    const right = douglasPeucker(points.slice(idx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

function roundCoord([lon, lat]) {
  const f = 10 ** COORD_DECIMALS;
  return [Math.round(lon * f) / f, Math.round(lat * f) / f];
}

function simplifyRing(ring) {
  const simplified = douglasPeucker(ring, SIMPLIFY_TOLERANCE_DEG).map(roundCoord);
  // Garantir un anneau valide (>= 4 points, fermé)
  if (simplified.length < 4) return ring.map(roundCoord);
  return simplified;
}

function simplifyGeometry(geometry) {
  if (geometry.type === "Polygon") {
    return { ...geometry, coordinates: geometry.coordinates.map(simplifyRing) };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((poly) => poly.map(simplifyRing)),
    };
  }
  return geometry;
}

function simplifyFeatureCollection(fc) {
  return {
    type: "FeatureCollection",
    features: fc.features
      .filter((f) => f.geometry)
      .map((f) => ({
        ...f,
        geometry: simplifyGeometry(f.geometry),
      })),
  };
}

// Ray casting point-in-polygon (gère Polygon et MultiPolygon)
function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonGeometry(point, geometry) {
  if (geometry.type === "Polygon") {
    const [outer, ...holes] = geometry.coordinates;
    if (!pointInRing(point, outer)) return false;
    return !holes.some((hole) => pointInRing(point, hole));
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((poly) =>
      pointInPolygonGeometry(point, { type: "Polygon", coordinates: poly })
    );
  }
  return false;
}

function findArrondissement(point, arrondissements) {
  for (const feature of arrondissements.features) {
    if (pointInPolygonGeometry(point, feature.geometry)) {
      return feature.properties.c_ar; // numéro d'arrondissement (1-20)
    }
  }
  return null;
}

async function processParis() {
  console.log("Téléchargement du référentiel des arrondissements de Paris...");
  const arrondissements = await fetchJson(PARIS_ARRONDISSEMENTS_URL);

  const sourcesOut = [];

  for (const ds of PARIS_DATASETS) {
    console.log(`Téléchargement Paris/${ds.key}...`);
    const data = await fetchJson(ds.url);

    const byArr = new Map(); // numero arrondissement -> features[]
    let unmatched = 0;

    for (const feature of data.features) {
      const point = feature.properties?.geo_point_2d;
      if (!point) {
        unmatched++;
        continue;
      }
      const arr = findArrondissement([point.lon, point.lat], arrondissements);
      if (arr == null) {
        unmatched++;
        continue;
      }
      if (!byArr.has(arr)) byArr.set(arr, []);
      byArr.get(arr).push(feature);
    }

    console.log(`  -> ${byArr.size} arrondissements, ${unmatched} secteurs non assignés (ignorés)`);

    for (const [arr, features] of byArr.entries()) {
      const postal = `750${String(arr).padStart(2, "0")}`;
      const fileId = `paris-${ds.key}-${postal}`;
      const fc = simplifyFeatureCollection({ type: "FeatureCollection", features });
      await writeFile(
        path.join(DATA_DIR, `${fileId}.geojson`),
        JSON.stringify(fc)
      );
      sourcesOut.push({ key: ds.key, arr, postal, fileId });
    }
  }

  return sourcesOut;
}

// ---------------------------------------------------------------------------
// Adjacence géométrique des arrondissements parisiens (pour afficher les
// voisins en contexte autour du territoire sélectionné). Calculée une fois
// à partir des vraies frontières, pas une table codée en dur.
// ---------------------------------------------------------------------------
function ringsOf(geometry) {
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}

function downsampleRing(ring, targetPoints) {
  const step = Math.max(1, Math.floor(ring.length / targetPoints));
  const out = [];
  for (let i = 0; i < ring.length; i += step) out.push(ring[i]);
  return out;
}

function pointToSegmentDistance(p, a, b) {
  const [x, y] = p, [x1, y1] = a, [x2, y2] = b;
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  let t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function countCloseSegments(ringA, ringB, threshold) {
  let close = 0;
  for (const p of ringA) {
    let minD = Infinity;
    for (let i = 0; i < ringB.length - 1; i++) {
      const d = pointToSegmentDistance(p, ringB[i], ringB[i + 1]);
      if (d < minD) minD = d;
      if (minD < threshold) break;
    }
    if (minD < threshold) close++;
  }
  return close;
}

async function computeParisAdjacency() {
  console.log("Calcul de l'adjacence des arrondissements de Paris...");
  const data = await fetchJson(PARIS_ARRONDISSEMENTS_URL);
  const polys = data.features.map((f) => ({
    c_ar: f.properties.c_ar,
    rings: ringsOf(f.geometry).map((r) => downsampleRing(r, 400)),
  }));

  const THRESHOLD_DEG = 0.00008; // ~9m
  const MIN_CLOSE_POINTS = 3; // plusieurs points proches = vraie frontière, pas un simple contact ponctuel
  const adjacency = {};
  polys.forEach((p) => (adjacency[p.c_ar] = []));

  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      let maxClose = 0;
      for (const ringA of polys[i].rings) {
        for (const ringB of polys[j].rings) {
          const c = countCloseSegments(ringA, ringB, THRESHOLD_DEG);
          if (c > maxClose) maxClose = c;
        }
      }
      if (maxClose >= MIN_CLOSE_POINTS) {
        adjacency[polys[i].c_ar].push(polys[j].c_ar);
        adjacency[polys[j].c_ar].push(polys[i].c_ar);
      }
    }
  }

  Object.values(adjacency).forEach((arr) => arr.sort((a, b) => a - b));
  await writeFile(
    path.join(DATA_DIR, "paris-arrondissements-adjacency.json"),
    JSON.stringify(adjacency)
  );
  console.log("  -> OK");
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  console.log("== Alpes-Maritimes (simplification du fichier existant) ==");
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(
      await readFile(path.join(DATA_DIR, "alpes-maritimes-colleges.geojson"), "utf8")
    );
    const simplified = simplifyFeatureCollection(raw);
    await writeFile(
      path.join(DATA_DIR, "alpes-maritimes-colleges.geojson"),
      JSON.stringify(simplified)
    );
    console.log(`  -> OK (${simplified.features.length} features)`);
  } catch (err) {
    console.error(`  -> ECHEC simplification Alpes-Maritimes: ${err.message}`);
  }

  console.log("== Sources simples ==");
  for (const s of SIMPLE_SOURCES) {
    if (s.skip) continue;
    console.log(`Téléchargement ${s.id}...`);
    try {
      const data = await fetchJson(s.url);
      const simplified = simplifyFeatureCollection(data);
      await writeFile(path.join(DATA_DIR, `${s.id}.geojson`), JSON.stringify(simplified));
      console.log(`  -> OK (${data.features?.length ?? "?"} features)`);
    } catch (err) {
      console.error(`  -> ECHEC pour ${s.id}: ${err.message}`);
    }
  }

  console.log("\n== Paris (découpage par arrondissement) ==");
  const parisSources = await processParis();

  console.log("\n== Adjacence des arrondissements de Paris ==");
  await computeParisAdjacency();

  console.log("\nTerminé. Fichiers Paris générés :", parisSources.length);
  console.log("Pense à mettre à jour sources.json si la liste des fichiers a changé.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
