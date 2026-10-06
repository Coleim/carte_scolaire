#!/usr/bin/env node
/**
 * Nettoyage a posteriori : certaines communes multi-secteurs ont produit de
 * très nombreuses petites cellules de Voronoï non fusionnées (le dissolve
 * topologique peut échouer sur des géométries en bordure de tolérance
 * flottante). On re-fusionne, par commune + secteur, tout groupe qui compte
 * un nombre de fragments anormalement élevé.
 *
 * Usage: node scripts/merge-fragmented-sectors.mjs
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as turf from "@turf/turf";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
const FRAGMENT_THRESHOLD = 8; // au-delà, on tente de refusionner

function combineAsMultiPolygon(features) {
  const polygons = [];
  for (const f of features) {
    if (f.geometry.type === "Polygon") polygons.push(f.geometry.coordinates);
    else if (f.geometry.type === "MultiPolygon") polygons.push(...f.geometry.coordinates);
  }
  return turf.feature(
    { type: "MultiPolygon", coordinates: polygons },
    { ...features[0].properties }
  );
}

async function processFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  const fc = JSON.parse(raw);

  const groups = new Map(); // "insee|rne" -> features[]
  const others = [];
  for (const f of fc.features) {
    const insee = f.properties.code_insee;
    const rne = f.properties.code_rne;
    if (insee == null || rne == null) { others.push(f); continue; }
    const key = `${insee}|${rne}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  let mergedGroups = 0;
  const finalFeatures = [...others];
  for (const [key, feats] of groups.entries()) {
    if (feats.length <= FRAGMENT_THRESHOLD) {
      finalFeatures.push(...feats);
      continue;
    }
    const merged = combineAsMultiPolygon(feats);
    finalFeatures.push(merged);
    mergedGroups++;
  }

  if (mergedGroups === 0) return null;

  const newFc = { type: "FeatureCollection", features: finalFeatures };
  await writeFile(filePath, JSON.stringify(newFc));
  return {
    file: path.basename(filePath),
    before: fc.features.length,
    after: finalFeatures.length,
    mergedGroups,
  };
}

async function main() {
  const files = (await readdir(DATA_DIR)).filter(
    (f) => f.startsWith("communes-colleges-") && f.endsWith(".geojson")
  );
  console.log(`Analyse de ${files.length} fichiers départementaux...`);

  const results = [];
  for (const file of files) {
    const res = await processFile(path.join(DATA_DIR, file));
    if (res) {
      console.log(`  ${res.file}: ${res.before} -> ${res.after} features (${res.mergedGroups} groupes fusionnés)`);
      results.push(res);
    }
  }

  console.log(`\nTerminé. ${results.length} fichiers corrigés.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
