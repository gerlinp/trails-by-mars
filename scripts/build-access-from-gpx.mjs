import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const xml = fs.readFileSync(path.join(root, 'data/trails/Pond Meadow Park Loop.gpx'), 'utf8');
const pts = [];
for (const m of xml.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"/g)) {
    pts.push([parseFloat(m[2]), parseFloat(m[1])]);
}

const gj = JSON.parse(fs.readFileSync(path.join(root, 'data/trails/pond-meadow-paved.geojson'), 'utf8'));
let osm = [];
for (const f of gj.features || []) {
    const g = f.geometry;
    if (g.type === 'LineString') osm = osm.concat(g.coordinates);
}

function distLL(a, b) {
    const R = 6371000;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const m =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(m)));
}

function ptSegDist(p, a, b) {
    let best = 1e99;
    for (let t = 0; t <= 20; t++) {
        const f = t / 20;
        const lng = a[0] + f * (b[0] - a[0]);
        const lat = a[1] + f * (b[1] - a[1]);
        const d = distLL(p, [lng, lat]);
        if (d < best) best = d;
    }
    return best;
}

function distToPoly(p) {
    let m = 1e99;
    for (let i = 0; i < osm.length - 1; i++) {
        const d = ptSegDist(p, osm[i], osm[i + 1]);
        if (d < m) m = d;
    }
    return m;
}

const TH = 26;
/** Ignore joins until this far along GPX — avoids snapping to wrong OSM segment near parking. */
const MIN_CUM_METERS_BEFORE_JOIN = 380;

let cum = 0;
let join = -1;
for (let i = 0; i < pts.length; i++) {
    if (i > 0) cum += distLL(pts[i - 1], pts[i]);
    if (cum < MIN_CUM_METERS_BEFORE_JOIN) continue;
    if (distToPoly(pts[i]) <= TH) {
        join = i;
        break;
    }
}

if (join < 1) {
    console.error('No join found within', TH, 'm after', MIN_CUM_METERS_BEFORE_JOIN, 'm walked');
    process.exit(1);
}

const spur = pts.slice(0, join + 1);
const len = spur.reduce((s, p, i, a) => (i ? s + distLL(a[i - 1], p) : s), 0);

const out = {
    type: 'Feature',
    properties: {
        name: 'Liberty St parking to paved loop',
        source: 'GPX trace clipped where it meets OSM loop geometry'
    },
    geometry: {
        type: 'LineString',
        coordinates: spur
    }
};

fs.writeFileSync(path.join(root, 'data/trails/pond-meadow-paved-access.geojson'), JSON.stringify(out, null, 2));
console.log('joinIdx', join, 'spurVertices', spur.length, 'pathM', len.toFixed(0));
