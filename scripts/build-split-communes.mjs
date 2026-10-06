#!/usr/bin/env node
/**
 * Traite les communes "multi-secteurs" du fichier national (ignorées par
 * build-national-colleges.mjs) en deux catégories :
 *
 *  1. Secteur partagé ("multi-collèges") : toute la commune est associée à
 *     plusieurs collèges au choix (pas de découpage géographique dans la
 *     donnée source). On affiche un seul polygone communal avec un libellé
 *     listant les établissements.
 *
 *  2. Vraie coupure géographique : la commune est découpée par rue/numéro
 *     entre plusieurs collèges. On reconstruit une approximation du
 *     découpage via :
 *       - les adresses réelles (BAN, Base Adresse Nationale) de la commune,
 *       - le rattachement adresse -> collège donné par le fichier source
 *         (nom de rue + plage de numéros + parité),
 *       - un diagramme de Voronoï entre les rues (regroupées par règle),
 *         découpé sur le contour officiel de la commune.
 *     Le résultat est une mosaïque de polygones collée au contour communal,
 *     sans trou, qui approxime la vraie frontière de secteur (précision
 *     dépendant de la densité du réseau de rues, pas une vérité cadastrale).
 *
 * Nécessite le fichier source (voir build-national-colleges.mjs) et un accès
 * réseau aux CSV de la Base Adresse Nationale (adresse.data.gouv.fr) — gros
 * téléchargements temporaires par département, non committés (voir /tmp).
 *
 * Usage: node scripts/build-split-communes.mjs
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import path from "node:path";
import * as turf from "@turf/turf";
import { Delaunay } from "d3-delaunay";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SOURCE_FILE = path.join(ROOT, "fr-en-carte-scolaire-colleges-publics.json");
const TMP_DIR = "/private/var/folders/hy/v4yccxs96394wpfzpf8p2s_00000gp/T/opencode/carte-scolaire-ban";

const EXCLUDED_DEPT_CODES = new Set(["006", "011", "022", "031", "038", "044", "049", "065", "075", "092"]);

const SIMPLIFY_TOLERANCE_DEG = 0.0002;
const COORD_DECIMALS = 6;

function perpendicularDistance(p, a, b) {
  const [x, y] = p, [x1, y1] = a, [x2, y2] = b;
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}
function douglasPeucker(points, tolerance) {
  if (points.length < 3) return points;
  let maxDist = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) { maxDist = d; idx = i; }
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
  const s = douglasPeucker(ring, SIMPLIFY_TOLERANCE_DEG).map(roundCoord);
  return s.length < 4 ? ring.map(roundCoord) : s;
}
function simplifyGeometry(geometry) {
  if (geometry.type === "Polygon") return { ...geometry, coordinates: geometry.coordinates.map(simplifyRing) };
  if (geometry.type === "MultiPolygon") return { ...geometry, coordinates: geometry.coordinates.map((p) => p.map(simplifyRing)) };
  return geometry;
}

function normStreet(s) {
  return (s || "")
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deptFolderPrefix(code3) {
  if (code3.startsWith("97")) return code3;
  if (code3 === "720") return "2B";
  if (code3 === "020") return "2A";
  const n = parseInt(code3, 10);
  return n < 10 ? `0${n}` : String(n);
}

const FOLDER_NAMES = {
  "01": "01-ain", "02": "02-aisne", "03": "03-allier", "04": "04-alpes-de-haute-provence",
  "05": "05-hautes-alpes", "06": "06-alpes-maritimes", "07": "07-ardeche", "08": "08-ardennes",
  "09": "09-ariege", "10": "10-aube", "11": "11-aude", "12": "12-aveyron",
  "13": "13-bouches-du-rhone", "14": "14-calvados", "15": "15-cantal", "16": "16-charente",
  "17": "17-charente-maritime", "18": "18-cher", "19": "19-correze", "21": "21-cote-d-or",
  "22": "22-cotes-d-armor", "23": "23-creuse", "24": "24-dordogne", "25": "25-doubs",
  "26": "26-drome", "27": "27-eure", "28": "28-eure-et-loir", "29": "29-finistere",
  "2A": "2A-corse-du-sud", "2B": "2B-haute-corse", "30": "30-gard", "31": "31-haute-garonne",
  "32": "32-gers", "33": "33-gironde", "34": "34-herault", "35": "35-ille-et-vilaine",
  "36": "36-indre", "37": "37-indre-et-loire", "38": "38-isere", "39": "39-jura",
  "40": "40-landes", "41": "41-loir-et-cher", "42": "42-loire", "43": "43-haute-loire",
  "44": "44-loire-atlantique", "45": "45-loiret", "46": "46-lot", "47": "47-lot-et-garonne",
  "48": "48-lozere", "49": "49-maine-et-loire", "50": "50-manche", "51": "51-marne",
  "52": "52-haute-marne", "53": "53-mayenne", "54": "54-meurthe-et-moselle", "55": "55-meuse",
  "56": "56-morbihan", "57": "57-moselle", "58": "58-nievre", "59": "59-nord",
  "60": "60-oise", "61": "61-orne", "62": "62-pas-de-calais", "63": "63-puy-de-dome",
  "64": "64-pyrenees-atlantiques", "65": "65-hautes-pyrenees", "66": "66-pyrenees-orientales",
  "67": "67-bas-rhin", "68": "68-haut-rhin", "69": "69-rhone", "70": "70-haute-saone",
  "71": "71-saone-et-loire", "72": "72-sarthe", "73": "73-savoie", "74": "74-haute-savoie",
  "75": "75-paris", "76": "76-seine-maritime", "77": "77-seine-et-marne", "78": "78-yvelines",
  "79": "79-deux-sevres", "80": "80-somme", "81": "81-tarn", "82": "82-tarn-et-garonne",
  "83": "83-var", "84": "84-vaucluse", "85": "85-vendee", "86": "86-vienne",
  "87": "87-haute-vienne", "88": "88-vosges", "89": "89-yonne", "90": "90-territoire-de-belfort",
  "91": "91-essonne", "92": "92-hauts-de-seine", "93": "93-seine-saint-denis", "94": "94-val-de-marne",
  "95": "95-val-d-oise", "971": "971-guadeloupe", "972": "972-martinique", "973": "973-guyane",
  "974": "974-la-reunion", "976": "976-mayotte",
};

async function fetchJson(url) {
  const maxRetries = 3;
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} pour ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Secours pour les arrondissements municipaux (Paris/Lyon/Marseille), absents
// des fichiers communaux "classiques" (france-geojson ne connaît que la ville
// entière). L'API Carto de l'IGN expose ces découpages individuellement.
const arrondissementCache = new Map();
async function fetchArrondissementBoundary(inseeCode) {
  if (arrondissementCache.has(inseeCode)) return arrondissementCache.get(inseeCode);
  try {
    const data = await fetchJson(`https://apicarto.ign.fr/api/cadastre/commune?code_insee=${inseeCode}`);
    const feature = data.features?.[0] || null;
    arrondissementCache.set(inseeCode, feature);
    return feature;
  } catch {
    arrondissementCache.set(inseeCode, null);
    return null;
  }
}

async function ensureBanCsv(deptCode2) {
  await mkdir(TMP_DIR, { recursive: true });
  const csvPath = path.join(TMP_DIR, `ban-${deptCode2}.csv`);
  if (existsSync(csvPath)) return csvPath;
  const url = `https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-${deptCode2}.csv.gz`;
  console.log(`    Téléchargement BAN ${deptCode2}...`);
  const maxRetries = 3;
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`BAN HTTP ${res.status} pour ${deptCode2}`);
      const gzPath = csvPath + ".gz";
      await pipeline(Readable.fromWeb(res.body), createWriteStream(gzPath));
      const { createReadStream } = await import("node:fs");
      await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(csvPath));
      await rm(gzPath);
      return csvPath;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function loadBanIndex(deptCode2, communeCodes) {
  const csvPath = await ensureBanCsv(deptCode2);
  const { createReadStream } = await import("node:fs");
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });

  const wanted = new Set(communeCodes);
  const byCommune = new Map(); // insee -> [{numero, street, lon, lat}]
  let header = null;
  let idx = null;

  for await (const line of rl) {
    if (!header) {
      header = line.split(";");
      idx = Object.fromEntries(header.map((h, i) => [h, i]));
      continue;
    }
    // Pre-filter cheaply: code_insee column check without full split when possible
    const cols = line.split(";");
    const insee = cols[idx.code_insee];
    if (!wanted.has(insee)) continue;
    const numero = parseInt(cols[idx.numero], 10);
    const street = normStreet(cols[idx.nom_voie]);
    const lon = parseFloat(cols[idx.lon]);
    const lat = parseFloat(cols[idx.lat]);
    if (!street || Number.isNaN(lon) || Number.isNaN(lat)) continue;
    if (!byCommune.has(insee)) byCommune.set(insee, []);
    byCommune.get(insee).push({ numero: Number.isNaN(numero) ? null : numero, street, lon, lat });
  }
  return byCommune;
}

function buildStreetRules(rows) {
  const streetToRules = new Map();
  for (const r of rows) {
    const key = normStreet(r.type_et_libelle);
    if (!streetToRules.has(key)) streetToRules.set(key, []);
    streetToRules.get(key).push({
      debut: r.n_de_voie_debut ?? 0,
      fin: r.n_de_voie_fin ?? 999999,
      parite: r.parite,
      rne: r.code_rne,
    });
  }
  return streetToRules;
}

function matchRule(streetToRules, street, numero) {
  const rules = streetToRules.get(street);
  if (!rules) return null;
  for (const rule of rules) {
    if (numero == null) return rule;
    if (numero < rule.debut || numero > rule.fin) continue;
    if (rule.parite === "P" && numero % 2 !== 0) continue;
    if (rule.parite === "I" && numero % 2 === 0) continue;
    return rule;
  }
  return rules[0] ?? null;
}

function splitCommuneVoronoi(communeFeature, addresses, streetToRules) {
  const seedGroups = new Map(); // "street|ruleIdx" -> {sumLon,sumLat,count,rne}
  for (const a of addresses) {
    const rules = streetToRules.get(a.street);
    if (!rules) continue;
    const rule = matchRule(streetToRules, a.street, a.numero);
    if (!rule) continue;
    const ruleIdx = rules.indexOf(rule);
    const key = `${a.street}|${ruleIdx}`;
    if (!seedGroups.has(key)) seedGroups.set(key, { sumLon: 0, sumLat: 0, count: 0, rne: rule.rne });
    const g = seedGroups.get(key);
    g.sumLon += a.lon; g.sumLat += a.lat; g.count++;
  }

  const seeds = Array.from(seedGroups.values())
    .filter((g) => g.count > 0)
    .map((g) => ({ lon: g.sumLon / g.count, lat: g.sumLat / g.count, rne: g.rne }));

  if (seeds.length < 2) return null; // pas assez de données pour un vrai découpage

  const communePoly = turf.feature(communeFeature.geometry);
  const coords = seeds.map((s) => [s.lon, s.lat]);
  const delaunay = Delaunay.from(coords);
  const bbox = turf.bbox(communePoly);
  const margin = 0.01;
  const voronoi = delaunay.voronoi([bbox[0] - margin, bbox[1] - margin, bbox[2] + margin, bbox[3] + margin]);

  const cellFeatures = [];
  for (let i = 0; i < coords.length; i++) {
    const cell = voronoi.cellPolygon(i);
    if (!cell) continue;
    let cellPoly;
    try { cellPoly = turf.polygon([cell]); } catch { continue; }
    let clipped;
    try { clipped = turf.intersect(turf.featureCollection([cellPoly, communePoly])); } catch { continue; }
    if (!clipped) continue;
    clipped.properties = { code_rne: seeds[i].rne };
    cellFeatures.push(clipped);
  }
  if (cellFeatures.length === 0) return null;

  let dissolved;
  try {
    dissolved = turf.dissolve(turf.flatten(turf.featureCollection(cellFeatures)), { propertyName: "code_rne" });
  } catch {
    dissolved = turf.flatten(turf.featureCollection(cellFeatures));
  }
  return dissolved.features;
}

async function main() {
  if (!existsSync(SOURCE_FILE)) {
    console.error(`Fichier source manquant : ${SOURCE_FILE}`);
    process.exit(1);
  }

  console.log("Lecture du fichier national...");
  const rows = JSON.parse(await readFile(SOURCE_FILE, "utf8"));

  console.log("Téléchargement de l'annuaire des collèges...");
  const colleges = await fetchJson(
    "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-annuaire-education/exports/json?where=type_etablissement%3D%22Coll%C3%A8ge%22&select=identifiant_de_l_etablissement,nom_etablissement,nom_commune,statut_public_prive"
  );
  const uaiToNom = new Map(colleges.map((c) => [c.identifiant_de_l_etablissement, c.nom_etablissement]));

  const communeToRows = new Map();
  for (const r of rows) {
    if (!r.code_insee || !r.code_rne) continue;
    if (!communeToRows.has(r.code_insee)) communeToRows.set(r.code_insee, []);
    communeToRows.get(r.code_insee).push(r);
  }

  const sharedByDept = new Map(); // code_departement -> [{insee, rnes, libelle_commune}]
  const splitByDept = new Map(); // code_departement -> [{insee, rows, libelle_commune}]

  for (const [insee, rs] of communeToRows.entries()) {
    const rnes = new Set(rs.map((r) => r.code_rne));
    if (rnes.size <= 1) continue;
    const dept = rs[0].code_departement;
    if (EXCLUDED_DEPT_CODES.has(dept)) continue;
    const hasStreet = rs.some((r) => r.type_et_libelle);
    if (!hasStreet) {
      if (!sharedByDept.has(dept)) sharedByDept.set(dept, []);
      sharedByDept.get(dept).push({ insee, rnes: Array.from(rnes), libelle_commune: rs[0].libelle_commune });
    } else {
      if (!splitByDept.has(dept)) splitByDept.set(dept, []);
      splitByDept.get(dept).push({ insee, rows: rs, libelle_commune: rs[0].libelle_commune });
    }
  }

  const allDepts = new Set([...sharedByDept.keys(), ...splitByDept.keys()]);
  const onlyDepts = process.env.ONLY_DEPTS ? new Set(process.env.ONLY_DEPTS.split(",")) : null;
  const deptsToProcess = onlyDepts ? Array.from(allDepts).filter((d) => onlyDepts.has(d)) : Array.from(allDepts);
  console.log(`\n${deptsToProcess.length} départements à traiter (secteurs partagés + coupures géographiques).\n`);

  const manifest = { shared: [], split: [], failures: [] };

  for (const dept of deptsToProcess.sort()) {
    const folderPrefix = deptFolderPrefix(dept);
    const folderName = FOLDER_NAMES[folderPrefix];
    if (!folderName) {
      manifest.failures.push({ dept, error: "dossier inconnu" });
      continue;
    }

    try {
      const communesGeoUrl = `https://raw.githubusercontent.com/gregoiredavid/france-geojson/master/departements/${folderName}/communes-${folderName}.geojson`;
      const communesGeo = await fetchJson(communesGeoUrl);
      const communeByInsee = new Map(communesGeo.features.map((f) => [f.properties.code, f]));

      const newFeatures = [];

      // 1. Secteurs partagés : un seul polygone, label listant les collèges
      const sharedList = sharedByDept.get(dept) || [];
      for (const s of sharedList) {
        let feature = communeByInsee.get(s.insee);
        if (!feature) feature = await fetchArrondissementBoundary(s.insee);
        if (!feature) continue;
        const noms = s.rnes.map((rne) => uaiToNom.get(rne) || rne);
        newFeatures.push({
          type: "Feature",
          geometry: simplifyGeometry(feature.geometry),
          properties: {
            code_insee: s.insee,
            nom_commune: s.libelle_commune,
            code_rne: s.rnes.join("+"),
            nom_college: noms.join(" ou "),
          },
        });
      }

      // 2. Vraies coupures géographiques : Voronoï sur adresses BAN
      const splitList = splitByDept.get(dept) || [];
      let splitOk = 0, splitFailed = 0;
      if (splitList.length > 0) {
        const communeCodes = splitList.map((s) => s.insee);
        const banByCommune = await loadBanIndex(folderPrefix, communeCodes);

        for (const s of splitList) {
          const communeFeature = communeByInsee.get(s.insee) || (await fetchArrondissementBoundary(s.insee));
          const addresses = banByCommune.get(s.insee);
          if (!communeFeature || !addresses || addresses.length === 0) {
            splitFailed++;
            continue;
          }

          const streetToRules = buildStreetRules(s.rows);
          const pieces = splitCommuneVoronoi(communeFeature, addresses, streetToRules);
          if (!pieces) {
            splitFailed++;
            continue;
          }

          for (const piece of pieces) {
            const rne = piece.properties.code_rne;
            newFeatures.push({
              type: "Feature",
              geometry: simplifyGeometry(piece.geometry),
              properties: {
                code_insee: s.insee,
                nom_commune: s.libelle_commune,
                code_rne: rne,
                nom_college: uaiToNom.get(rne) || rne,
              },
            });
          }
          splitOk++;
        }
      }

      if (newFeatures.length === 0) {
        console.log(`  ${dept} (${folderName}): rien à ajouter`);
        continue;
      }

      // Fusion avec le fichier département existant (communes mono-secteur)
      const existingPath = path.join(DATA_DIR, `communes-colleges-${folderPrefix.toLowerCase()}.geojson`);
      let existingFeatures = [];
      if (existsSync(existingPath)) {
        const existing = JSON.parse(await readFile(existingPath, "utf8"));
        existingFeatures = existing.features;
      }

      const merged = { type: "FeatureCollection", features: [...existingFeatures, ...newFeatures] };
      await writeFile(existingPath, JSON.stringify(merged));

      console.log(
        `  ${dept} (${folderName}): +${sharedList.length} partagés, ${splitOk}/${splitList.length} coupures géo réussies -> total ${merged.features.length} entités`
      );
      manifest.shared.push({ dept, count: sharedList.length });
      manifest.split.push({ dept, ok: splitOk, failed: splitFailed, total: splitList.length });
    } catch (err) {
      console.error(`  ${dept}: ECHEC (${err.message})`);
      manifest.failures.push({ dept, error: err.message });
    }
  }

  await writeFile(path.join(DATA_DIR, "split-communes-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("\nTerminé. Voir data/split-communes-manifest.json pour le détail.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
