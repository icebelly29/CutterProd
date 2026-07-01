import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, 'index.cjs');

console.log('Building CommonJS target...');

let utils = fs.readFileSync(path.join(__dirname, 'src/utils.js'), 'utf8');
let math = fs.readFileSync(path.join(__dirname, 'src/math.js'), 'utf8');
let svg = fs.readFileSync(path.join(__dirname, 'src/SvgConverter.js'), 'utf8');

// Strip exports/imports
utils = utils.replace(/export function /g, 'function ');
math = math.replace(/export class /g, 'class ');
svg = svg.replace(/export default class /g, 'class ');
svg = svg.replace(/import .*\n/g, '');

let code = [utils, math, svg].join('\n\n');

// Append CommonJS exports
code += `\n
module.exports = SvgConverter;
module.exports.SvgConverter = SvgConverter;
module.exports.Vector2 = Vector2;
module.exports.CubicBezier = CubicBezier;
module.exports.crc8 = crc8;
module.exports.packMicrosegment = packMicrosegment;
`;

fs.writeFileSync(distPath, code);

// Generate ES module bundle for the web frontend
let esmCode = [utils, math, svg].join('\n\n');
esmCode += `\nexport { Vector2, CubicBezier, packMicrosegment, crc8 };\nexport default SvgConverter;\n`;
fs.writeFileSync(path.join(__dirname, 'index.esm.js'), esmCode);

console.log('Build completed successfully! Generated index.cjs and index.esm.js.');
