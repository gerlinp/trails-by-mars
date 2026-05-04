/**
 * Un-indent modal/detail rules from @media (max-width: 767px) so they apply at all widths;
 * positioning still overridden per breakpoint elsewhere.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = path.join(__dirname, '..', 'css', 'maps.css');

let lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);

const mediaStart = lines.findIndex(
    (l, i) =>
        l.trim() === '@media (max-width: 767px) {' &&
        i >= 690 &&
        lines[i + 2] &&
        lines[i + 2].includes('body.page-maps.map-detail-modal-open')
);

if (mediaStart < 0) {
    console.error('Could not find modal @media block');
    process.exit(1);
}

let depth = 0;
let endLine = -1;
for (let i = mediaStart; i < lines.length; i++) {
    for (const ch of lines[i]) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
    }
    if (i > mediaStart && depth === 0) {
        endLine = i;
        break;
    }
}

if (endLine < 0) {
    console.error('Could not find closing brace');
    process.exit(1);
}

const inner = lines.slice(mediaStart + 1, endLine);
const dedented = inner.map((line) => (line.startsWith('    ') ? line.slice(4) : line));

const newLines = [...lines.slice(0, mediaStart), ...dedented, ...lines.slice(endLine + 1)];

fs.writeFileSync(p, newLines.join('\n'), 'utf8');
console.log('Unwrapped modal CSS:', mediaStart + 1, '-', endLine + 1, '→', dedented.length, 'lines');
