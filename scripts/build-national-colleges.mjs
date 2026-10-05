#!/usr/bin/env node
/**
 * Génère une couche "collèges" approximative à l'échelle NATIONALE à partir
 * du fichier ministériel "Carte scolaire des collèges publics" (adresses /
 * communes -> code UAI du collège de secteur), en l'agrégeant au niveau de
 * la commune (polygones officiels, dépôt france-geojson) pour les communes
 * mono-secteur (~95% des cas).
 *
 * Ne remplace PAS les sources précises déjà intégrées (Alpes-Maritimes,
 * Isère, Haute-Garonne, Aude, Loire-Atlantique, Maine-et-Loire,
 * Hautes-Pyrénées, Hauts-de-Seine, Paris) : ces départements sont exclus
 * ici pour éviter les doublons avec des données plus fines.
 *
 * Prérequis : avoir le fichier source téléchargé manuellement depuis
 * https://www.data.gouv.fr/datasets/carte-scolaire-des-colleges-publics/
 * (trop volumineux / pas d'export GeoJSON direct pour l'automatiser) sous
 * le nom fr-en-carte-scolaire-colleges-publics.json à la racine du projet.
 *
 * Usage: node scripts/build-national-colleges.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SOURCE_FILE = path.join(ROOT, "fr-en-carte-scolaire-colleges-publics.json");

// Départements déjà couverts par une source précise dédiée : on les exclut
// de la génération nationale (approximative) pour éviter les doublons.
const EXCLUDED_DEPT_CODES = new Set([
  "006", // Alpes-Maritimes
  "011", // Aude
  "031", // Haute-Garonne
  "038", // Isère
  "044", // Loire-Atlantique
  "049", // Maine-et-Loire
  "065", // Hautes-Pyrénées
  "075", // Paris (déjà découpé par arrondissement)
  "092", // Hauts-de-Seine
]);

const SIMPLIFY_TOLERANCE_DEG = 0.0003; // communes = formes simples, tolérance un peu plus large
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
  const simplified = douglasPeucker(ring, SIMPLIFY_TOLERANCE_DEG).map(roundCoord);
  return simplified.length < 4 ? ring.map(roundCoord) : simplified;
}

function simplifyGeometry(geometry) {
  if (geometry.type === "Polygon") {
    return { ...geometry, coordinates: geometry.coordinates.map(simplifyRing) };
  }
  if (geometry.type === "MultiPolygon") {
    return { ...geometry, coordinates: geometry.coordinates.map((poly) => poly.map(simplifyRing)) };
  }
  return geometry;
}

function deptFolderPrefix(code3) {
  if (code3.startsWith("97")) return code3; // DOM : "971".."976"
  if (code3 === "720") return "2B"; // Haute-Corse
  if (code3 === "020") return "2A"; // Corse-du-Sud (normalement absent du jeu de données)
  const n = parseInt(code3, 10);
  return n < 10 ? `0${n}` : String(n);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} pour ${url}`);
  return res.json();
}

async function main() {
  if (!existsSync(SOURCE_FILE)) {
    console.error(`Fichier source manquant : ${SOURCE_FILE}`);
    console.error("Télécharge-le depuis https://www.data.gouv.fr/datasets/carte-scolaire-des-colleges-publics/");
    process.exit(1);
  }

  console.log("Lecture du fichier national (peut prendre quelques secondes)...");
  const rows = JSON.parse(await readFile(SOURCE_FILE, "utf8"));
  console.log(`  -> ${rows.length} lignes`);

  console.log("Téléchargement de l'annuaire des collèges (UAI -> nom)...");
  const colleges = await fetchJson(
    "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-annuaire-education/exports/json?where=type_etablissement%3D%22Coll%C3%A8ge%22&select=identifiant_de_l_etablissement,nom_etablissement,nom_commune,statut_public_prive"
  );
  const uaiToNom = new Map(colleges.map((c) => [c.identifiant_de_l_etablissement, c.nom_etablissement]));
  console.log(`  -> ${uaiToNom.size} collèges référencés`);

  console.log("Regroupement par commune (recherche des communes mono-secteur)...");
  const communeToRnes = new Map(); // code_insee -> Set(code_rne)
  const communeDept = new Map(); // code_insee -> code_departement (3 chars)
  for (const r of rows) {
    if (!r.code_insee || !r.code_rne) continue;
    if (!communeToRnes.has(r.code_insee)) communeToRnes.set(r.code_insee, new Set());
    communeToRnes.get(r.code_insee).add(r.code_rne);
    communeDept.set(r.code_insee, r.code_departement);
  }

  const singleByDept = new Map(); // code_departement -> Map(code_insee -> code_rne)
  let singleCount = 0, multiCount = 0;
  for (const [insee, set] of communeToRnes.entries()) {
    if (set.size !== 1) { multiCount++; continue; }
    singleCount++;
    const dept = communeDept.get(insee);
    if (!singleByDept.has(dept)) singleByDept.set(dept, new Map());
    singleByDept.get(dept).set(insee, Array.from(set)[0]);
  }
  console.log(`  -> ${singleCount} communes mono-secteur, ${multiCount} ignorées (multi-secteur / trop fines)`);

  const deptEntries = Array.from(singleByDept.entries())
    .filter(([dept]) => !EXCLUDED_DEPT_CODES.has(dept))
    .sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`\n${deptEntries.length} départements à traiter (hors ceux déjà couverts finement).\n`);

  await mkdir(DATA_DIR, { recursive: true });
  const generated = [];
  const failures = [];

  for (const [dept, communeMap] of deptEntries) {
    const folderPrefix = deptFolderPrefix(dept);
    let folderName;
    try {
      // On connaît le slug exact grâce au listing GitHub (voir README du repo) ;
      // on tente le pattern standard puis on retombe sur une recherche si besoin.
      folderName = FOLDER_NAMES[folderPrefix];
      if (!folderName) throw new Error(`Pas de dossier connu pour le préfixe ${folderPrefix}`);

      const url = `https://raw.githubusercontent.com/gregoiredavid/france-geojson/master/departements/${folderName}/communes-${folderName}.geojson`;
      const communesGeo = await fetchJson(url);

      const features = [];
      for (const feature of communesGeo.features) {
        const insee = feature.properties.code;
        const rne = communeMap.get(insee);
        if (!rne) continue;
        features.push({
          type: "Feature",
          geometry: simplifyGeometry(feature.geometry),
          properties: {
            code_insee: insee,
            nom_commune: feature.properties.nom,
            code_rne: rne,
            nom_college: uaiToNom.get(rne) || rne,
          },
        });
      }

      if (features.length === 0) {
        console.log(`  ${dept} (${folderName}): 0 commune exploitable, ignoré`);
        continue;
      }

      const fc = { type: "FeatureCollection", features };
      const fileId = `communes-colleges-${folderPrefix.toLowerCase()}`;
      await writeFile(path.join(DATA_DIR, `${fileId}.geojson`), JSON.stringify(fc));
      console.log(`  ${dept} (${folderName}): ${features.length} communes -> ${fileId}.geojson`);
      generated.push({ dept, folderPrefix, folderName, fileId, count: features.length });
    } catch (err) {
      console.error(`  ${dept}: ECHEC (${err.message})`);
      failures.push({ dept, error: err.message });
    }
  }

  await writeFile(
    path.join(DATA_DIR, "national-colleges-manifest.json"),
    JSON.stringify({ generated, failures }, null, 2)
  );

  console.log(`\nTerminé. ${generated.length} départements générés, ${failures.length} échecs.`);
  console.log("Voir data/national-colleges-manifest.json pour le détail.");
}

// Table de correspondance préfixe -> nom de dossier (dépôt france-geojson)
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
