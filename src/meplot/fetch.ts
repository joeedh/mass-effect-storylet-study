/**
 * Download BioWare's plot databases (as shipped with LegendaryExplorer) at a pinned revision.
 *
 * The databases are not vendored in this repository: they are fetched into `build/plotdb` and
 * verified against a pinned SHA-256 so every derived artifact is reproducible.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

const LEX_REPO = 'ME3Tweaks/LegendaryExplorer';
const LEX_COMMIT = 'b8869f92c7b80be7818447b5079f65c99b4a97b8';
const ZIP_PATH = 'LegendaryExplorer/LegendaryExplorerCore/Embedded/PlotDatabases.zip';
const ZIP_SHA256 = '48aee954405f8725dad88b87563f2de8fafd05e6218e7a5cee5a170cf6265ada';
export const ZIP_URL = `https://raw.githubusercontent.com/${LEX_REPO}/${LEX_COMMIT}/${ZIP_PATH}`;
export const DB_FILES = ['le1.json', 'le2.json', 'le3.json'] as const;

export function haveDatabases(dest: string): boolean {
  return DB_FILES.every((name) => fs.existsSync(path.join(dest, name)));
}

/** Fetch and unpack the plot databases into `dest`. Returns the extracted paths. */
export async function fetchPlotDb(dest: string, force = false, url = ZIP_URL): Promise<string[]> {
  fs.mkdirSync(dest, { recursive: true });
  const targets = DB_FILES.map((name) => path.join(dest, name));
  if (!force && haveDatabases(dest)) return targets;
  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!resp.ok) throw new Error(`fetching ${url}: HTTP ${resp.status}`);
  const blob = new Uint8Array(await resp.arrayBuffer());
  const digest = createHash('sha256').update(blob).digest('hex');
  if (digest !== ZIP_SHA256) {
    throw new Error(`PlotDatabases.zip checksum mismatch: got ${digest}, expected ${ZIP_SHA256}`);
  }
  const files = unzipSync(blob, {
    filter: (f) => (DB_FILES as readonly string[]).includes(f.name),
  });
  for (const name of DB_FILES) {
    const data = files[name];
    if (data === undefined) throw new Error(`PlotDatabases.zip has no ${name}`);
    fs.writeFileSync(path.join(dest, name), data);
  }
  fs.writeFileSync(
    path.join(dest, 'SOURCE.txt'),
    `${url}\nsha256=${ZIP_SHA256}\nLicense: GPL-3.0 (LegendaryExplorer); plot data originates from BioWare's games.\n`,
    'utf8',
  );
  return targets;
}
