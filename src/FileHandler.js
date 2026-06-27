/**
 * ============================================================================
 *                       FILE IMPORT & PROCESSING
 * ============================================================================
 * 
 * This module acts as the "Receptionist" for files. It decides what to do with
 * files dropped onto the page or selected by the user.
 * 
 * PIPELINE:
 * 1. Detection: Is it a .gcode file or an .svg file?
 * 
 * 2. G-CODE Path (Simple):
 *    - Just reads the text content.
 *    - Sends it directly to the machine.
 * 
 * 3. SVG Path (Complex):
 *    We must prepare the vector graphic for the physical constraints of the plotter.
 *    
 *    A. Unit Normalization:
 *       SVGs can be in pixels, inches, cm, mm, etc. We try to convert everything
 *       to millimeters (mm) to match the machine.
 *       
 *    B. Scaling (Auto-Fit):
 *       If the drawing is 500mm wide but the bed is only 230mm, we automatically
 *       shrink the drawing to fit safely within the margins.
 *       
 *    C. Centering:
 *       We calculate the offsets needed to place the drawing exactly in the
 *       middle of the bed.
 *       
 *    D. Coordinate Flip:
 *       Computer screens have (0,0) at the Top-Left.
 *       CNC machines usually have (0,0) at the Bottom-Left.
 *       We have to mathematically flip the Y-axis so the drawing isn't upside down.
 * 
 *    E. Conversion:
 *       Finally, we pass all these parameters to 'SvgConverter.js' to get the G-code.
 * ============================================================================
 */

/**
 * @file FileHandler.js
 * @description FILE IMPORT LOGIC
 * 
 * Handles loading files from the computer.
 * - If it's a G-Code file: Just load the text.
 * - If it's an SVG file: We have to do a lot of math to convert it to G-code.
 */

import SvgConverter from './SvgConverter.js?v=6';
import { log } from './Console.js';

function parseEmbeddedUrumiMeta(svg) {
    const metaEl = Array.from(svg.querySelectorAll('meta'))
        .find(el => el.getAttribute('name') === 'urumi-scanner');
    if (!metaEl) return null;

    try {
        const meta = JSON.parse(metaEl.getAttribute('content') || '{}');
        const dotsPerMM = Number(meta.dots_per_mm);
        const physicalWidth = Number(meta.physical_width);
        const physicalHeight = Number(meta.physical_height);
        if (!Number.isFinite(dotsPerMM) || dotsPerMM <= 0) return null;
        if (!Number.isFinite(physicalWidth) || physicalWidth <= 0) return null;
        if (!Number.isFinite(physicalHeight) || physicalHeight <= 0) return null;
        return {
            dots_per_mm: dotsPerMM,
            physical_width: physicalWidth,
            physical_height: physicalHeight
        };
    } catch (err) {
        log(`Ignoring unreadable scanner metadata: ${err.message}`, 'warning');
        return null;
    }
}

function tokenizePathData(d) {
    return d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) || [];
}

function parsePolylinePathData(d) {
    const tokens = tokenizePathData(d);
    const subpaths = [];
    let points = [];
    let closed = false;
    let i = 0;

    while (i < tokens.length) {
        const command = tokens[i++];
        if (!command || !/[a-zA-Z]/.test(command)) return null;
        const type = command.toUpperCase();
        if (command !== type || (type !== 'M' && type !== 'L' && type !== 'Z')) return null;

        if (type === 'Z') {
            closed = true;
            continue;
        }

        const x = Number(tokens[i++]);
        const y = Number(tokens[i++]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

        if (type === 'M' && points.length) {
            subpaths.push({ points, closed });
            points = [];
            closed = false;
        }
        points.push({ x, y });
    }

    if (points.length) subpaths.push({ points, closed });
    return subpaths.length ? subpaths : null;
}

function pointSegmentDistance(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);

    const rawT = ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy);
    const t = Math.max(0, Math.min(1, rawT));
    return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function simplifyPolyline(points, tolerancePx) {
    if (points.length <= 2) return points;

    let maxDistance = 0;
    let splitIndex = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const distance = pointSegmentDistance(points[i], points[0], points[points.length - 1]);
        if (distance > maxDistance) {
            maxDistance = distance;
            splitIndex = i;
        }
    }

    if (maxDistance <= tolerancePx) return [points[0], points[points.length - 1]];

    const first = simplifyPolyline(points.slice(0, splitIndex + 1), tolerancePx);
    const second = simplifyPolyline(points.slice(splitIndex), tolerancePx);
    return first.slice(0, -1).concat(second);
}

function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function smoothClosedPolyline(points, iterations = 1) {
    if (points.length < 8) return points;

    let closedPoints = points.slice();
    const hadDuplicateClose = pointDistance(closedPoints[0], closedPoints[closedPoints.length - 1]) < 0.001;
    if (hadDuplicateClose) closedPoints = closedPoints.slice(0, -1);

    let smoothed = closedPoints;
    for (let iter = 0; iter < iterations; iter++) {
        smoothed = smoothed.map((point, idx) => {
            const prev = smoothed[(idx - 1 + smoothed.length) % smoothed.length];
            const next = smoothed[(idx + 1) % smoothed.length];
            return {
                x: (prev.x * 0.25) + (point.x * 0.5) + (next.x * 0.25),
                y: (prev.y * 0.25) + (point.y * 0.5) + (next.y * 0.25)
            };
        });
    }

    if (hadDuplicateClose) smoothed.push({ ...smoothed[0] });
    return smoothed;
}

function simplifyClosedPolyline(points) {
    return smoothClosedPolyline(points, 1);
}

function pointsChanged(a, b) {
    if (a.length !== b.length) return true;
    return a.some((point, idx) => pointDistance(point, b[idx]) > 0.01);
}

function formatSvgNumber(value) {
    return Number(value.toFixed(2)).toString();
}

function simplifyScannerSvgPaths(svg, meta) {
    const tolerancePx = Math.max(1.5, Math.min(4, meta.dots_per_mm * 0.3));
    const closedTolerancePx = Math.max(0.45, Math.min(0.8, meta.dots_per_mm * 0.09));
    let beforePoints = 0;
    let afterPoints = 0;
    let changedPaths = 0;

    svg.querySelectorAll('path').forEach(path => {
        const d = path.getAttribute('d');
        if (!d) return;

        const subpaths = parsePolylinePathData(d);
        if (!subpaths) return;

        const parts = [];
        let changed = false;
        subpaths.forEach(({ points, closed }) => {
            beforePoints += points.length;
            const minimum = closed ? 3 : 2;
            const simplified = points.length > minimum
                ? (closed ? simplifyClosedPolyline(points, closedTolerancePx) : simplifyPolyline(points, tolerancePx))
                : points;
            const safePoints = simplified.length >= minimum ? simplified : points;
            afterPoints += safePoints.length;
            if (pointsChanged(safePoints, points)) changed = true;

            if (!safePoints.length) return;
            const [first, ...rest] = safePoints;
            const commands = [`M ${formatSvgNumber(first.x)} ${formatSvgNumber(first.y)}`];
            rest.forEach(point => {
                commands.push(`L ${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`);
            });
            if (closed) commands.push('Z');
            parts.push(commands.join(' '));
        });

        if (parts.length) {
            path.setAttribute('d', parts.join(' '));
            if (changed) changedPaths += 1;
        }
    });

    return { beforePoints, afterPoints, changedPaths, tolerancePx, closedTolerancePx };
}

/**
 * Process an uploaded file (SVG or GCode).
 * 
 * @param {File} file - The file object from Input or Drag/Drop.
 * @param {Function} onGCodeReady - Callback to save the new GCode.
 * @param {Function} onSwitchTab - Callback to change the view.
 */
export async function handleFile(file, onGCodeReady, onSwitchTab, urumiMeta = null) {
    if (!file) return;
    log(`Loading ${file.name}...`, 'info');

    try {
        const text = await file.text();
        let conversionText = text;
        let resolvedUrumiMeta = urumiMeta;

        // --- CASE 1: SVG FILE ---
        if (file.name.toLowerCase().endsWith('.svg')) {

            // 1. Parse the XML
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'image/svg+xml');
            const svg = doc.querySelector('svg');

            if (svg) {
                // Remove ignored elements (like the visual frame) so they aren't processed into trajectories
                const ignoredNodes = svg.querySelectorAll('[data-ignore="true"]');
                ignoredNodes.forEach(node => node.remove());
                
                // Re-serialize back to text so SvgConverter (which uses text parsing) ignores them
                conversionText = new XMLSerializer().serializeToString(svg);

                const embeddedMeta = parseEmbeddedUrumiMeta(svg);
                if (!resolvedUrumiMeta && embeddedMeta) {
                    resolvedUrumiMeta = embeddedMeta;
                    log(
                        `Scanner SVG metadata detected (${embeddedMeta.physical_width.toFixed(1)}x${embeddedMeta.physical_height.toFixed(1)}mm, ${embeddedMeta.dots_per_mm.toFixed(2)} px/mm)`,
                        'info'
                    );
                }

                if (resolvedUrumiMeta && embeddedMeta) {
                    const stats = simplifyScannerSvgPaths(svg, resolvedUrumiMeta);
                    conversionText = new XMLSerializer().serializeToString(svg);
                    if (stats.changedPaths > 0) {
                        log(
                            `Refined scanner paths: ${stats.beforePoints} -> ${stats.afterPoints} points (open ${stats.tolerancePx.toFixed(1)}px, closed ${stats.closedTolerancePx.toFixed(1)}px)`,
                            'info'
                        );
                    }
                }
            }

            // 2. Show the raw SVG in the "SVG Preview" tab
            if (svg) {
                // Force it to fit the preview window
                svg.style.width = '100%';
                svg.style.height = '100%';

                const svgPreview = document.getElementById('svgPreview');
                svgPreview.innerHTML = '';
                svgPreview.appendChild(svg);
            }

            // 3. Determine Dimensions (Complex!)
            // SVGs can use mm, cm, in, px, or no units at all.
            // We try to find the "Real World" size of the drawing.
            const bedW = parseFloat(document.getElementById('bedWidthInput')?.value) || 600;
            const bedH = parseFloat(document.getElementById('bedHeightInput')?.value) || 750;
            let w_mm = 0, h_mm = 0;
            let viewbox = [0, 0, 0, 0];

            if (svg) {
                const wAttr = svg.getAttribute('width');
                const hAttr = svg.getAttribute('height');
                const vbAttr = svg.getAttribute('viewBox');

                if (vbAttr) {
                    viewbox = vbAttr.split(/[ ,]+/).map(parseFloat);
                }

                // Helper to convert strings like "10in" to mm
                const parseToMM = (str) => {
                    if (!str) return 0;
                    const val = parseFloat(str);
                    if (isNaN(val)) return 0;
                    if (str.endsWith('mm')) return val;
                    if (str.endsWith('cm')) return val * 10;
                    if (str.endsWith('in')) return val * 25.4;
                    if (str.endsWith('pt')) return val * (25.4 / 72);
                    if (str.endsWith('pc')) return val * (25.4 / 6);
                    if (str.endsWith('px')) return val * 0.264583;
                    return val; // Assume mm if no unit provided
                };

                w_mm = parseToMM(wAttr);
                h_mm = parseToMM(hAttr);

                // Fallback: If width/height are missing, use ViewBox width/height
                if (w_mm === 0 && viewbox.length === 4) w_mm = viewbox[2];
                if (h_mm === 0 && viewbox.length === 4) h_mm = viewbox[3];
            }

            // --- SCALING & MAPPING LOGIC ---
            let scale = 1.0;
            let finalOffsetX = 0;
            let finalOffsetY = 0;
            let finalW = 0;
            let finalH = 0;

            let vbW = viewbox.length === 4 ? viewbox[2] : w_mm;
            let vbH = viewbox.length === 4 ? viewbox[3] : h_mm;
            if (vbW === 0) vbW = w_mm;
            if (vbH === 0) vbH = h_mm;

            if (resolvedUrumiMeta) {
                // Direct physical mapping from UrumiCam bed scanner
                scale = 1.0 / resolvedUrumiMeta.dots_per_mm;

                // The machine's physical origin is bottom-right, so camera-space
                // X and Y must both be mirrored into machine-space.
                finalOffsetX = resolvedUrumiMeta.physical_width;
                finalOffsetY = resolvedUrumiMeta.physical_height;

                finalW = resolvedUrumiMeta.physical_width;
                finalH = resolvedUrumiMeta.physical_height;
                log(`Direct visual alignment loaded: ${finalW.toFixed(1)}x${finalH.toFixed(1)}mm gantry bed at origin`, 'success');
            } else {
                const isCanvas = svg.getAttribute('data-source') === 'canvas';

                // 1. Calculate initial scale (Unit Conversion)
                scale = (vbW > 0) ? (w_mm / vbW) : 1.0;

                const margin = 10; // 10mm safety margin
                let currentW = vbW * scale;
                let currentH = vbH * scale;

                // 2. Auto-Fit (Scale Down)
                if (!isCanvas && (currentW > (bedW - margin) || currentH > (bedH - margin))) {
                    const scaleW = (bedW - margin) / currentW;
                    const scaleH = (bedH - margin) / currentH;
                    const fitScale = Math.min(scaleW, scaleH);
                    scale *= fitScale;
                    log(`Scaled down to fit bed (${(fitScale * 100).toFixed(0)}%)`, 'info');
                }

                // 3. Centering
                finalW = vbW * scale;
                finalH = vbH * scale;

                let offsetX = 0;
                let offsetY = 0;

                if (!isCanvas) {
                    offsetX = (bedW - finalW) / 2;
                    offsetY = (bedH - finalH) / 2;
                }

                const vbMinX = viewbox.length === 4 ? viewbox[0] : 0;
                const vbMinY = viewbox.length === 4 ? viewbox[1] : 0;

                // Align to center or leave at 0,0 for Canvas
                if (isCanvas) {
                    // The draw canvas is authored in a bottom-left logical space,
                    // but the machine's real origin is bottom-right.
                    finalOffsetX = bedW;
                    finalOffsetY = bedH;
                } else {
                    // Normalize standard SVGs to 0,0 and then shift to centered offsetX
                    finalOffsetX = offsetX - (vbMinX * scale);
                    finalOffsetY = offsetY - (vbMinY * scale);
                }
            }

            // Read inversion checkboxes
            let invertXElement = document.getElementById('invertXCheckbox');
            let flipX = invertXElement ? invertXElement.checked : false;

            let invertYElement = document.getElementById('invertYCheckbox');
            let flipY = invertYElement ? invertYElement.checked : false;

            // Canvas SVGs and UrumiCam Captures:
            // Both need the machine's true bottom-right origin, so force both flips.
            // The inversion checkboxes apply only to externally-loaded SVG files.
            const isCanvasSrc = !resolvedUrumiMeta && svg && svg.getAttribute('data-source') === 'canvas';
            if (isCanvasSrc || resolvedUrumiMeta) {
                flipX = true;
                flipY = true;
            }


            try {
                // Get segment length from UI
                const segInput = document.getElementById('segmentLengthInput');
                let segLength = segInput ? parseFloat(segInput.value) : 1.0;
                if (isNaN(segLength) || segLength < 0.1) segLength = 0.1;

                // Local helper for safe DOM parsing
                function axisSteps(inputId, fallback) {
                    const v = parseFloat(document.getElementById(inputId)?.value);
                    return (isNaN(v) || v <= 0) ? fallback : v;
                }

                const stepsPerMM_X = axisSteps('xStepsPerMM', 160);
                const stepsPerMM_Y = axisSteps('yStepsPerMM', 160);
                const stepsPerMM_Z = axisSteps('zStepsPerMM', 1200);
                const stepsPerDeg_A = axisSteps('aStepsPerDeg', 103);

                const cuttingSpeedInput = document.getElementById('cuttingSpeedInput');
                const cuttingSpeed = cuttingSpeedInput ? parseFloat(cuttingSpeedInput.value) : 30;

                const zSpeedInput = document.getElementById('zSpeedInput');
                const zSpeed = zSpeedInput ? parseFloat(zSpeedInput.value) : 5;

                const idX = parseInt(document.getElementById('xRs485Id')?.value) || 3;
                const idY = parseInt(document.getElementById('yRs485Id')?.value) || 2;
                const idZ = parseInt(document.getElementById('zRs485Id')?.value) || 1;
                const idA = parseInt(document.getElementById('aRs485Id')?.value) || 4;

                const maxStepsInput = document.getElementById('maxStepsInput');
                const maxSteps = maxStepsInput ? parseInt(maxStepsInput.value) : 30000;

                const maxLinearSpeedInput = document.getElementById('maxLinearSpeedInput');
                const maxRotationalSpeedInput = document.getElementById('maxRotationalSpeedInput');
                const maxLinearSpeed = maxLinearSpeedInput ? parseInt(maxLinearSpeedInput.value) : 200;
                const maxRotationalSpeed = maxRotationalSpeedInput ? parseInt(maxRotationalSpeedInput.value) : 720;

                // flipX/flipY are resolved above (with canvas-source override),
                // so do NOT re-read them here — they shadow the corrected values.

                // Run the conversion!
                const converter = new SvgConverter({
                    flipX: flipX,
                    flipY: flipY,
                    feedRate: cuttingSpeed,
                    zFeedRate: zSpeed,
                    maxSteps: maxSteps,
                    maxLinearSpeed: maxLinearSpeed,
                    maxRotationalSpeed: maxRotationalSpeed,
                    scale: scale,
                    offsetX: finalOffsetX,
                    offsetY: finalOffsetY,
                    segmentLength: segLength,
                    stepsPerMM_X: stepsPerMM_X,
                    stepsPerMM_Y: stepsPerMM_Y,
                    stepsPerMM_Z: stepsPerMM_Z,
                    stepsPerDeg_A: stepsPerDeg_A,
                    idX: idX,
                    idY: idY,
                    idZ: idZ,
                    idA: idA,
                    bedW: bedW,
                    bedH: bedH,
                    docW: finalW,
                    docH: finalH
                });
                const result = converter.convert(conversionText);

                onGCodeReady(result, stepsPerMM_X);
                log(`Converted (Size: ${finalW.toFixed(1)}x${finalH.toFixed(1)}mm)`, 'success');
                onSwitchTab('gcode-preview');
            } catch (err) {
                log(`Conversion Error: ${err.message}`, 'error');
            }

        } else {
            // --- CASE 2: G-CODE FILE ---
            // Simple: just read the text and use it.
            // Wrap in the same {preamble, packets} envelope (no binary packets).
            onGCodeReady({ preamble: text.split('\n').filter(l => l.trim()), packets: [] });
            log('G-Code loaded.', 'success');
            onSwitchTab('gcode-preview');
        }
    } catch (err) {
        log(`File Read Error: ${err.message}`, 'error');
    }
}
