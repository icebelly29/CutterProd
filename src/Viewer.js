/**
 * ============================================================================
 *                       G-CODE VISUALIZER (CANVAS)
 * ============================================================================
 * 
 * This module draws the "Map" of what the machine is going to do.
 * 
 * COORDINATE MAPPING:
 * 1. Machine World: Origin (0,0) is at the BOTTOM-RIGHT. +X goes LEFT. +Y goes UP. (Millimeters)
 * 2. Canvas World: Origin (0,0) is at the TOP-LEFT. +Y goes DOWN. (Pixels)
 * 
 * This module dynamically scales and translates the physical coordinate space
 * to the visual canvas space, allowing zooming, panning, and distance measurement.
 * ============================================================================
 */

import { CoordinateMapper } from './CoordinateMapper.js';

function distToSegment(px, py, x1, y1, x2, y2) {
    const l2 = (x1 - x2) ** 2 + (y1 - y2) ** 2;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

function updateShapeStats(shapeId, paths) {
    const overlay = document.getElementById('shapeStatsOverlay');
    if (!overlay) return;

    if (!shapeId) {
        overlay.classList.add('hidden');
        return;
    }

    let totalLen = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const p of paths) {
        if (p.shapeId === shapeId && p.type === 'cut') {
            totalLen += Math.hypot(p.to.x - p.from.x, p.to.y - p.from.y);
            minX = Math.min(minX, p.from.x, p.to.x);
            maxX = Math.max(maxX, p.from.x, p.to.x);
            minY = Math.min(minY, p.from.y, p.to.y);
            maxY = Math.max(maxY, p.from.y, p.to.y);
        }
    }

    // Fallback if there are no cut paths (e.g. only move paths)
    if (minX === Infinity) minX = maxX = minY = maxY = 0;

    const idEl = document.getElementById('statsShapeId');
    if (idEl) idEl.textContent = shapeId.substring(0, 12) + (shapeId.length > 12 ? '...' : '');

    const lenEl = document.getElementById('statsShapeLength');
    if (lenEl) lenEl.textContent = totalLen.toFixed(1) + ' mm';

    const widthEl = document.getElementById('statsShapeWidth');
    if (widthEl) widthEl.textContent = (maxX - minX).toFixed(1) + ' mm';

    const heightEl = document.getElementById('statsShapeHeight');
    if (heightEl) heightEl.textContent = (maxY - minY).toFixed(1) + ' mm';

    overlay.classList.remove('hidden');
}


export function renderGCode(gcode, canvasId = 'gcodeCanvas', containerId = 'canvasContainer', stepsPerMM = 1.0, activePathIndex = -1, packets = null, packetMeta = []) {
    const canvas = document.getElementById(canvasId);
    const container = document.getElementById(containerId);
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');

    // --- 1. Setup Dimensions & Bounds ---
    const bedW = parseFloat(document.getElementById('bedWidthInput')?.value) || 630;
    const bedH = parseFloat(document.getElementById('bedHeightInput')?.value) || 780;
    const gantryW = parseFloat(document.getElementById('gantryWidthInput')?.value) || 210;
    const gantryH = parseFloat(document.getElementById('gantryHeightInput')?.value) || 180;

    const rect = container.getBoundingClientRect();
    if (rect.width >= 10 && rect.height >= 10) {
        canvas.width = rect.width;
        canvas.height = rect.height;
    } else if (canvas.width < 10 || canvas.height < 10) {
        canvas.width = 650;
        canvas.height = 760;
    }

    // --- 2. Decode Trajectories ---

    const paths = [];
    let cur = { x: 0, y: 0 };
    let pkCur = null;
    let isPenDown = false;

    let currentShapeId = null;
    let currentMethod = 'thru_cut';

    // Decode Text G-Code
    const lines = (gcode || '').split('\n');
    lines.forEach(line => {
        const rawLine = line.trim();
        if (rawLine.startsWith('; SHAPE_START')) {
            const idMatch = rawLine.match(/id=([\w-]+)/);
            const methodMatch = rawLine.match(/method=([\w_]+)/);
            if (idMatch) currentShapeId = idMatch[1];
            if (methodMatch) currentMethod = methodMatch[1];
        } else if (rawLine.startsWith('; SHAPE_END')) {
            currentShapeId = null;
            currentMethod = 'thru_cut';
        }

        line = line.split(';')[0].trim().toUpperCase();
        if (!line) return;

        const isMoveCommand = line.startsWith('MOVE') || line.startsWith('MSEG');
        if (isMoveCommand || (!line.startsWith('G') && !line.startsWith('M') && (line.includes(',') || line.includes(' ')))) {
            if (line.startsWith('X Y Z') || line.startsWith('XYZ X Y Z') || line.startsWith('ENABLE')) return;

            const parts = line.split(/[\s,]+/);

            if (parts.length > 0 && parts[0] === 'MSEG') {
                const dx = (parseInt(parts[1]) || 0);
                const dy = (parseInt(parts[2]) || 0);
                const dz = parseInt(parts[3]) || 0;

                const stepsPerMM_X = parseFloat(document.getElementById('xStepsPerMM')?.value) || 160;
                const stepsPerMM_Y = parseFloat(document.getElementById('yStepsPerMM')?.value) || 160;

                const mmX = -dx / stepsPerMM_X; // Un-invert the backward-wired X motor steps
                const mmY = dy / stepsPerMM_Y;

                if (dz > 0) isPenDown = true;
                else if (dz < 0) isPenDown = false;

                const next = { x: cur.x + mmX, y: cur.y + mmY };
                paths.push({
                    type: isPenDown ? 'cut' : 'move',
                    from: { ...cur },
                    to: { ...next },
                    shapeId: currentShapeId,
                    method: currentMethod
                });
                cur = next;
                return;
            }

            if (parts.length > 0 && parts[0] === 'MOVE') {
                const count = parseInt(parts[1]);
                if (isNaN(count) || parts.length < 2 + count * 2) return;

                const idX = parseInt(document.getElementById('xRs485Id')?.value) || 3;
                const idY = parseInt(document.getElementById('yRs485Id')?.value) || 2;
                const idZ = parseInt(document.getElementById('zRs485Id')?.value) || 1;
                const stepsPerMM_X = parseFloat(document.getElementById('xStepsPerMM')?.value) || 160;
                const stepsPerMM_Y = parseFloat(document.getElementById('yStepsPerMM')?.value) || 160;

                let dx = 0, dy = 0, zVal = 0;
                for (let i = 0; i < count; i++) {
                    const id = parseInt(parts[2 + i]);
                    const steps = parseInt(parts[2 + count + i]);
                    if (id === idX) dx = (steps / stepsPerMM_X);
                    else if (id === idY) dy = (steps / stepsPerMM_Y);
                    else if (id === idZ) zVal = steps;
                }

                if (zVal > 0) isPenDown = true;
                else if (zVal < 0) isPenDown = false;

                const next = { x: cur.x - dx, y: cur.y + dy }; // Un-invert dx
                paths.push({
                    type: isPenDown ? 'cut' : 'move',
                    from: { ...cur },
                    to: { ...next },
                    shapeId: currentShapeId,
                    method: currentMethod
                });
                cur = next;
                return;
            }

            if (parts.length > 0 && parts[0] === 'XYZ') parts.shift();
            if (parts.length >= 7 && !isNaN(parseFloat(parts[0]))) {
                const dx = -(parseFloat(parts[0]) / stepsPerMM); // Un-invert dx
                const dy = (parseFloat(parts[1]) / stepsPerMM);
                const zVal = parseFloat(parts[2]);
                if (zVal > 0) isPenDown = true;
                else if (zVal < 0) isPenDown = false;

                const next = { x: cur.x + dx, y: cur.y + dy };
                paths.push({
                    type: isPenDown ? 'cut' : 'move',
                    from: { ...cur },
                    to: { ...next }
                });
                cur = next;
            }
            return;
        }

        const isGMove = line.startsWith('G0') || line.startsWith('G1');
        if (isGMove) {
            const xMatch = line.match(/X([-+]?\d*\.?\d+)/);
            const yMatch = line.match(/Y([-+]?\d*\.?\d+)/);
            const next = { ...cur };
            if (xMatch) next.x = (parseFloat(xMatch[1]) / stepsPerMM);
            if (yMatch) next.y = (parseFloat(yMatch[1]) / stepsPerMM);

            paths.push({
                type: line.startsWith('G0') ? 'move' : 'cut',
                from: { ...cur },
                to: { ...next },
                shapeId: currentShapeId,
                method: currentMethod
            });
            cur = next;
        }
    });

    // Decode Binary Packets (Overrides GCode moves)
    if (packets && packets.length > 0) {
        const spmX = parseFloat(document.getElementById('xStepsPerMM')?.value) || 160;
        const spmY = parseFloat(document.getElementById('yStepsPerMM')?.value) || 160;

        pkCur = { x: 0, y: 0 };
        let pkPenDown = false;
        const ranges = Array.isArray(packetMeta) ? packetMeta : [];
        let rangeIndex = 0;

        for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
            const pkt = packets[packetIndex];
            if (pkt.length < 22) continue;
            const view = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
            if (view.getUint8(0) !== 0xAB) continue;

            const dx = view.getInt32(1, true);
            const dy = view.getInt32(5, true);
            const dz = view.getInt32(9, true);

            if (dz > 0) pkPenDown = true;
            else if (dz < 0) pkPenDown = false;

            const mmX = -dx / spmX; // Un-invert the backward-wired X motor steps
            const mmY = dy / spmY;
            const next = { x: pkCur.x + mmX, y: pkCur.y + mmY };

            while (rangeIndex < ranges.length && packetIndex > ranges[rangeIndex].end) {
                rangeIndex++;
            }
            const meta = ranges[rangeIndex];

            paths.push({
                type: pkPenDown ? 'cut' : 'move',
                from: { ...pkCur },
                to: { ...next },
                shapeId: meta && packetIndex >= meta.start && packetIndex <= meta.end ? meta.shapeId : null,
                method: meta && packetIndex >= meta.start && packetIndex <= meta.end ? meta.method : 'thru_cut'
            });
            pkCur = next;
        }
        cur = pkCur;
    }

    canvas._lastPaths = paths;

    // --- 3. Viewport & Pan/Zoom Logic ---
    const padding = 40;
    const availableW = Math.max(1, canvas.width - padding * 2);
    const availableH = Math.max(1, canvas.height - padding * 2);
    const baseScale = Math.min(availableW / bedW, availableH / bedH);

    if (!canvas._trajectoryViewport) {
        canvas._trajectoryViewport = {
            zoom: 1, panX: 0, panY: 0,
            dragging: false, dragX: 0, dragY: 0,
            dragStartX: 0, dragStartY: 0,
            measureStartX: null, measureStartY: null,
            measureEndX: null, measureEndY: null,
            selectedShapeId: null
        };
    }
    const viewport = canvas._trajectoryViewport;
    canvas._renderTrajectory = () => renderGCode(gcode, canvasId, containerId, stepsPerMM, activePathIndex, packets, packetMeta);

    const centerX = bedW / 2;
    const centerY = bedH / 2;
    const canvasCenterX = canvas.width / 2;
    const canvasCenterY = canvas.height / 2;
    const scale = baseScale * viewport.zoom;

    // Calculate the Canvas position of the bed's Top-Left corner (where mx = bedW, my = bedH)
    const offsetX = canvasCenterX + viewport.panX - (bedW / 2) * scale;
    const offsetY = canvasCenterY + viewport.panY - (bedH / 2) * scale;

    viewport.getMetrics = () => ({ scale, centerX, centerY, canvasCenterX, canvasCenterY, offsetX, offsetY, bedW, bedH });

    if (!canvas._trajectoryControlsReady) {
        canvas._trajectoryControlsReady = true;

        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            const vp = canvas._trajectoryViewport;
            const rectNow = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rectNow.width;
            const scaleY = canvas.height / rectNow.height;
            const pointerX = (event.clientX - rectNow.left) * scaleX;
            const pointerY = (event.clientY - rectNow.top) * scaleY;

            const oldZoom = vp.zoom;
            const zoomFactor = Math.exp(-event.deltaY * 0.0015);
            const newZoom = Math.max(0.1, Math.min(20, oldZoom * zoomFactor));
            const factor = newZoom / oldZoom;

            vp.panX = pointerX - canvas.width / 2 - (pointerX - canvas.width / 2 - vp.panX) * factor;
            vp.panY = pointerY - canvas.height / 2 - (pointerY - canvas.height / 2 - vp.panY) * factor;
            vp.zoom = newZoom;
            canvas._renderTrajectory?.();
        }, { passive: false });

        canvas.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 && event.button !== 1) return;
            event.preventDefault();
            const vp = canvas._trajectoryViewport;
            const rectNow = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rectNow.width;
            const scaleY = canvas.height / rectNow.height;
            const pointerX = (event.clientX - rectNow.left) * scaleX;
            const pointerY = (event.clientY - rectNow.top) * scaleY;

            const isMeasureMode = document.getElementById('btnMeasurePreview')?.classList.contains('active');

            if (isMeasureMode && event.button === 0) {
                const m = vp.getMetrics();
                const pos = CoordinateMapper.pointerToMachine(pointerX, pointerY, canvas.width, canvas.height, m.scale, m.offsetX, m.offsetY);

                vp.measureStartX = pos.x;
                vp.measureStartY = pos.y;
                vp.measureEndX = pos.x;
                vp.measureEndY = pos.y;
            } else {
                vp.dragging = true;
                vp.dragX = event.clientX;
                vp.dragY = event.clientY;
                vp.dragStartX = event.clientX;
                vp.dragStartY = event.clientY;
                canvas.classList.add('is-panning');
            }
            canvas.setPointerCapture?.(event.pointerId);
        });

        canvas.addEventListener('pointermove', (event) => {
            const vp = canvas._trajectoryViewport;
            const rectNow = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rectNow.width;
            const scaleY = canvas.height / rectNow.height;

            const isMeasureMode = document.getElementById('btnMeasurePreview')?.classList.contains('active');

            if (isMeasureMode && vp.measureStartX !== null && !vp.dragging) {
                event.preventDefault();
                const pointerX = (event.clientX - rectNow.left) * scaleX;
                const pointerY = (event.clientY - rectNow.top) * scaleY;

                const m = vp.getMetrics();
                const pos = CoordinateMapper.pointerToMachine(pointerX, pointerY, canvas.width, canvas.height, m.scale, m.offsetX, m.offsetY);
                vp.measureEndX = pos.x;
                vp.measureEndY = pos.y;
                canvas._renderTrajectory?.();
                return;
            }

            if (!vp.dragging) return;
            event.preventDefault();
            vp.panX += (event.clientX - vp.dragX) * scaleX;
            vp.panY += (event.clientY - vp.dragY) * scaleY;
            vp.dragX = event.clientX;
            vp.dragY = event.clientY;
            canvas._renderTrajectory?.();
        });

        const endPan = (event) => {
            const vp = canvas._trajectoryViewport;

            if (!document.getElementById('btnMeasurePreview')?.classList.contains('active')) {
                const distMoved = Math.hypot(event.clientX - (vp.dragStartX || event.clientX), event.clientY - (vp.dragStartY || event.clientY));
                if (distMoved < 5) {
                    const rectNow = canvas.getBoundingClientRect();
                    const scaleX = canvas.width / rectNow.width;
                    const scaleY = canvas.height / rectNow.height;
                    const pointerX = (event.clientX - rectNow.left) * scaleX;
                    const pointerY = (event.clientY - rectNow.top) * scaleY;

                    const m = vp.getMetrics();
                    const pos = CoordinateMapper.pointerToMachine(pointerX, pointerY, canvas.width, canvas.height, m.scale, m.offsetX, m.offsetY);
                    const mx = pos.x;
                    const my = pos.y;

                    let closestShape = null;
                    let minDist = 10 / m.scale; // 10 pixels threshold for easier clicking

                    if (canvas._lastPaths) {
                        for (const p of canvas._lastPaths) {
                            if (!p.shapeId) continue;
                            const d = distToSegment(mx, my, p.from.x, p.from.y, p.to.x, p.to.y);
                            if (d < minDist) {
                                minDist = d;
                                closestShape = p.shapeId;
                            }
                        }
                    }
                    vp.selectedShapeId = closestShape;
                    updateShapeStats(vp.selectedShapeId, canvas._lastPaths);
                }
            }

            vp.dragging = false;
            canvas.releasePointerCapture?.(event.pointerId);
            canvas.classList.remove('is-panning');
            canvas._renderTrajectory?.();
        };
        canvas.addEventListener('pointerup', endPan);
        canvas.addEventListener('pointercancel', endPan);
        canvas.addEventListener('dblclick', (event) => {
            event.preventDefault();
            const vp = canvas._trajectoryViewport;
            vp.zoom = 1;
            vp.panX = 0;
            vp.panY = 0;
            canvas._renderTrajectory?.();
        });
    }

    // --- 4. Render Logic ---
    const mapX = (x) => CoordinateMapper.machineToCanvas(x, 0, scale, offsetX, 0).x;
    const mapY = (y) => CoordinateMapper.machineToCanvas(0, y, scale, 0, offsetY).y;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(0, canvas.height);
    ctx.scale(1, -1);

    // Draw Machine Bed Border
    ctx.setLineDash([10, 5]);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(mapX(0), mapY(0), bedW * scale, bedH * scale);

    // Draw Labels
    ctx.save();
    ctx.scale(1, -1);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`0,0 (BL)`, mapX(0), -(mapY(0) - 16));
    ctx.restore();

    ctx.save();
    ctx.scale(1, -1);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${bedW}x${bedH}mm`, mapX(bedW), -(mapY(bedH) + 16));
    ctx.restore();

    // Draw Trajectory Paths
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    paths.forEach((p, idx) => {
        const startX = mapX(p.from.x);
        const startY = mapY(p.from.y);
        const endX = mapX(p.to.x);
        const endY = mapY(p.to.y);

        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);

        const isExecuted = activePathIndex >= 0 && idx <= activePathIndex;

        if (p.type === 'move') {
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = isExecuted ? 'rgba(59, 130, 246, 0.45)' : '#d1d5db';
            ctx.setLineDash([4, 4]);
            ctx.stroke();
        } else {
            const isSelected = p.shapeId && p.shapeId === viewport.selectedShapeId;
            let strokeColor = isSelected ? '#ff00ff' : (
                isExecuted ? '#10b981' : (
                    p.method === 'crease' ? '#22c55e' :
                        (p.method === 'score' || p.method === 'off_base') ? '#ef4444' : '#3b82f6'
                )
            );
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = isSelected ? 4 : (isExecuted ? 3 : 2);
            if (isSelected) {
                ctx.shadowColor = '#ff00ff';
                ctx.shadowBlur = 6;
            }
            ctx.setLineDash([]);
            ctx.stroke();
            ctx.shadowBlur = 0; // reset
        }
    });

    // Draw Measure Tool Overlay
    if (viewport.measureStartX !== null && viewport.measureEndX !== null) {
        const sx = mapX(viewport.measureStartX);
        const sy = mapY(viewport.measureStartY);
        const ex = mapX(viewport.measureEndX);
        const ey = mapY(viewport.measureEndY);
        const dist = Math.hypot(viewport.measureEndX - viewport.measureStartX, viewport.measureEndY - viewport.measureStartY);

        ctx.save();
        ctx.strokeStyle = '#eab308';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();

        ctx.setLineDash([]);
        ctx.fillStyle = '#eab308';
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill();

        if (dist > 0) {
            const label = `${dist.toFixed(1)} mm`;
            ctx.font = 'bold 12px ui-sans-serif, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const metrics = ctx.measureText(label);
            const pad = 6;
            const lx = (sx + ex) / 2;
            const ly = (sy + ey) / 2; // the actual midpoint

            ctx.save();
            ctx.scale(1, -1);
            
            ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
            ctx.beginPath();
            ctx.roundRect(lx - metrics.width / 2 - pad, -(ly - 20) - 10 - pad, metrics.width + pad * 2, 20 + pad * 2, 6);
            ctx.fill();

            ctx.fillStyle = '#fef08a';
            ctx.fillText(label, lx, -(ly - 20));
            ctx.restore();
        }
        ctx.restore();
    }

    // Draw Gantry Footprint
    if (paths.length > 0) {
        let gantryCenter = { x: 0, y: 0 };
        if (activePathIndex >= 0 && activePathIndex < paths.length) {
            gantryCenter = paths[activePathIndex].to;
        }

        const gantryX = mapX(gantryCenter.x - gantryW / 2);
        const gantryY = mapY(gantryCenter.y - gantryH / 2);

        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(gantryX, gantryY, gantryW * scale, gantryH * scale);

        ctx.fillStyle = 'rgba(239, 68, 68, 0.05)';
        ctx.fillRect(gantryX, gantryY, gantryW * scale, gantryH * scale);

        ctx.fillStyle = '#ef4444';
        ctx.beginPath(); ctx.arc(mapX(gantryCenter.x), mapY(gantryCenter.y), 4, 0, 2 * Math.PI); ctx.fill();

        ctx.save();
        ctx.scale(1, -1);
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`Gantry`, mapX(gantryCenter.x), -(gantryY - 16));
        ctx.restore();
        
        ctx.restore();
    } else {
        ctx.save();
        ctx.scale(1, -1);
        ctx.fillStyle = '#9ca3af';
        ctx.font = '14px ui-sans-serif, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText("No toolpaths found.", mapX(bedW/2), -mapY(bedH/2));
        ctx.restore();
    }
    
    ctx.restore(); // restore global coordinate transform
}
