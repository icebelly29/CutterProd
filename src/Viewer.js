/**
 * ============================================================================
 *                       G-CODE VISUALIZER (CANVAS)
 * ============================================================================
 * 
 * This module draws the "Map" of what the machine is going to do. It takes text
 * (G-code) and turns it into a picture on the screen.
 * 
 * THE BIG MATH PROBLEM (Coordinate Mapping):
 * 1. Machine World:
 *    - Origin (0,0) is at the BOTTOM-Left.
 *    - +Y goes UP.
 *    - Units are in Millimeters (mm).
 * 
 * 2. Computer Screen World (HTML Canvas):
 *    - Origin (0,0) is at the TOP-Left.
 *    - +Y goes DOWN.
 *    - Units are in Pixels (px).
 * 
 * HOW WE SOLVE IT:
 * We create two mapping functions 'mapX' and 'mapY' that act as translators.
 * [Machine X,Y] ---> [Scale] ---> [Flip Y] ---> [Offset] ---> [Screen Pixels]
 * 
 * VISUAL CUES:
 * - Solid Blue Lines: G1 (Cutting/Pen Down) - The machine is working.
 * - Dashed Grey Lines: G0 (Travel/Pen Up) - The machine is moving to a new spot.
 * - Dashed Box: Represents the physical size of the machine bed (230x310mm).
 * ============================================================================
 */

/**
 * @file Viewer.js
 * @description VISUALIZER
 * 
 * This module draws the G-code path on the HTML5 Canvas. 
 * 
 * CHALLENGE:
 * - Machine coordinates (Standard Cartesian): (0,0) is Bottom-Left. Y increases UP. 
 * - Computer Screen coordinates (Canvas): (0,0) is Top-Left. Y increases DOWN. 
 * 
 * We have to "map" (convert) every point from Machine Space to Screen Space.
 */

/**
 * Renders the G-code path.
 * @param {string} gcode - The raw G-code string.
 * @param {string} canvasId - HTML ID of the <canvas> element.
 * @param {string} containerId - HTML ID of the parent div (for sizing).
 */
export function renderGCode(gcode, canvasId = 'gcodeCanvas', containerId = 'canvasContainer', stepsPerMM = 1.0, activePathIndex = -1) {
    console.log("Viewer: Rendering G-Code with Sampling Points (v3)"); // Debug log to confirm update
    const canvas = document.getElementById(canvasId);
    const container = document.getElementById(containerId);
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');

    // --- 1. Setup Dimensions ---
    const bedW = parseFloat(document.getElementById('bedWidthInput')?.value) || 960; // Machine Width (mm)
    const bedH = parseFloat(document.getElementById('bedHeightInput')?.value) || 770; // Machine Height (mm)
    const gantryW = parseFloat(document.getElementById('gantryWidthInput')?.value) || 210; // Gantry Width (mm)
    const gantryH = parseFloat(document.getElementById('gantryHeightInput')?.value) || 180; // Gantry Height (mm)

    // Make the canvas match the size of its container div
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    // --- 2. Parse G-Code ---
    // We need to turn text lines ("G1 X10 Y20") into number objects ({x:10, y:20}).
    const lines = gcode.split('\n');
    const paths = [];
    let cur = { x: 0, y: 0 }; // Current pen position (starts at 0,0)
    let isPenDown = false; // Track pen state based on relative Z changes

    lines.forEach(line => {
        // Remove comments (text after ';') and whitespace
        line = line.split(';')[0].trim().toUpperCase();
        if (!line) return;

        // --- NEW: Trajectory Format ---
        // Format: move <count> <ids...> <steps...> <sps...>
        const isMoveCommand = line.toLowerCase().startsWith('move');
        if (isMoveCommand || (!line.startsWith('G') && !line.startsWith('M') && (line.includes(',') || line.includes(' ')))) {
            if (line.startsWith('X Y Z') || line.startsWith('XYZ X Y Z') || line.startsWith('ENABLE')) return; // Skip Header/Commands

            const parts = line.split(/[\s,]+/);
            
            if (parts.length > 0 && parts[0].toLowerCase() === 'move') {
                const count = parseInt(parts[1]);
                if (isNaN(count) || parts.length < 2 + count * 2) return;
                
                // Get configured IDs to map back to axes
                const idX = parseInt(document.getElementById('xRs485Id')?.value) || 3;
                const idY = parseInt(document.getElementById('yRs485Id')?.value) || 2;
                const idZ = parseInt(document.getElementById('zRs485Id')?.value) || 1;
                
                // Get Steps/MM to convert back to physical millimeters for the canvas
                const axisSteps = (mId, miId, dId, fallback) => {
                    const m  = parseFloat(document.getElementById(mId)?.value)  || 200;
                    const mi = parseFloat(document.getElementById(miId)?.value) || 1;
                    const d  = parseFloat(document.getElementById(dId)?.value)  || 1;
                    const v  = (m * mi) / d;
                    return (isNaN(v) || v <= 0) ? fallback : v;
                };

                const stepsPerMM_X = axisSteps('xMotorSteps','xMicrosteps','xMmPerRev', 160);
                const stepsPerMM_Y = axisSteps('yMotorSteps','yMicrosteps','yMmPerRev', 160);

                let dx = 0, dy = 0, zVal = 0;
                
                for (let i = 0; i < count; i++) {
                    const id = parseInt(parts[2 + i]);
                    const steps = parseInt(parts[2 + count + i]);
                    
                    if (id === idX) dx = steps / stepsPerMM_X;
                    else if (id === idY) dy = steps / stepsPerMM_Y;
                    else if (id === idZ) zVal = steps;
                }
                
                if (zVal > 0) isPenDown = true;  // Positive Z means moving Down
                else if (zVal < 0) isPenDown = false; // Negative Z means moving Up
                
                const isMove = !isPenDown;
                const next = { x: cur.x + dx, y: cur.y + dy };
                
                paths.push({
                    type: isMove ? 'move' : 'cut',
                    from: { ...cur },
                    to: { ...next }
                });
                cur = next;
                return;
            }

            // Legacy fallback
            if (parts.length > 0 && parts[0].toUpperCase() === 'XYZ') {
                parts.shift(); // Remove the "xyz" prefix
            }

            if (parts.length >= 7 && !isNaN(parseFloat(parts[0]))) {
                // xyz values are RELATIVE deltas in steps
                const dx = parseFloat(parts[0]) / stepsPerMM;
                const dy = parseFloat(parts[1]) / stepsPerMM;
                const zVal = parseFloat(parts[2]); // Relative Z change
                
                if (zVal > 0) isPenDown = true;  // Positive Z means moving Down
                else if (zVal < 0) isPenDown = false; // Negative Z means moving Up
                
                const isMove = !isPenDown;
                const next = { x: cur.x + dx, y: cur.y + dy };
                
                paths.push({
                    type: isMove ? 'move' : 'cut',
                    from: { ...cur },
                    to: { ...next }
                });
                cur = next;
            }
            return;
        }

        // --- LEGACY: G-Code Format ---
        const isMove = line.startsWith('G0') || line.startsWith('G1');
        if (isMove) {
            // Use Regex to find numbers after X and Y
            const xMatch = line.match(/X([-+]?\d*\.?\d+)/);
            const yMatch = line.match(/Y([-+]?\d*\.?\d+)/);
            
            const next = { ...cur };
            if (xMatch) next.x = parseFloat(xMatch[1]) / stepsPerMM;
            if (yMatch) next.y = parseFloat(yMatch[1]) / stepsPerMM;

            paths.push({
                type: line.startsWith('G0') ? 'move' : 'cut',
                from: { ...cur },
                to: { ...next }
            });
            cur = next; // Update current position
        }
    });

    // --- 3. Calculate viewport bounds (auto-fit to content + bed) ---
    // Compute bounding box of all path points, always including the bed rect
    let minX = 0, maxX = bedW, minY = 0, maxY = bedH;
    paths.forEach(p => {
        minX = Math.min(minX, p.from.x, p.to.x);
        maxX = Math.max(maxX, p.from.x, p.to.x);
        minY = Math.min(minY, p.from.y, p.to.y);
        maxY = Math.max(maxY, p.from.y, p.to.y);
    });

    const padding = 40; // px
    const availableW = canvas.width - padding * 2;
    const availableH = canvas.height - padding * 2;
    const dataW = maxX - minX || bedW;
    const dataH = maxY - minY || bedH;
    const scale = Math.min(availableW / dataW, availableH / dataH);
    console.log(`[Viewer Debug] bedW=${bedW}, bedH=${bedH}, minX=${minX}, maxX=${maxX}, minY=${minY}, maxY=${maxY}, scale=${scale}, availableW=${availableW}, availableH=${availableH}, dataW=${dataW}, dataH=${dataH}`);

    // Center the bounding box in the canvas
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const offsetX = canvas.width  / 2 - centerX * scale;
    const offsetY = canvas.height / 2 + centerY * scale;

    // --- 4. Coordinate Mapper Functions ---
    const mapX = (x) => x * scale + offsetX;
    const mapY = (y) => offsetY - y * scale; // flip Y (machine Y-up → canvas Y-down)

    // --- 5. Draw! ---
    ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear screen

    // Draw Bed Border
    ctx.setLineDash([10, 5]); // Dashed line
    ctx.strokeStyle = '#cbd5e1'; // Light grey
    ctx.lineWidth = 1;
    
    const bedX_canvas = mapX(0);
    const bedY_canvas = mapY(bedH); // Top-Left of bed in canvas coords
    
    ctx.strokeRect(bedX_canvas, bedY_canvas, bedW * scale, bedH * scale);
    
    // Draw Labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px ui-monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`0,0 (BL)`, mapX(0), mapY(0) + 15); // Label Origin
    ctx.textAlign = 'right';
    ctx.fillText(`${bedW}x${bedH}mm`, mapX(bedW), mapY(bedH) - 5); // Label Size

    // Draw The Path
    ctx.lineCap = 'round';

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
            // G0: Rapid Move (Pen Up) -> Grey/Light Blue Dashed Line
            ctx.lineWidth = 2;
            ctx.strokeStyle = isExecuted ? 'rgba(59, 130, 246, 0.45)' : '#d1d5db'; 
            ctx.setLineDash([5, 5]);
            ctx.stroke();
        } else {
            // G1: Cut Move (Pen Down) -> Emerald Green if executed, blue if pending
            ctx.strokeStyle = isExecuted ? '#10b981' : '#3b82f6'; 
            ctx.lineWidth = isExecuted ? 3 : 2;
            ctx.setLineDash([]);
            ctx.stroke();

            // VISUALIZE SAMPLING POINTS
            // Color: Bright Emerald Green if executed, Orange if pending
            ctx.fillStyle = isExecuted ? '#10b981' : '#ff6600'; 
            ctx.beginPath();
            ctx.arc(endX, endY, isExecuted ? 2.0 : 3.0, 0, 2 * Math.PI);
            ctx.fill();
        }
    });

    // Draw Gantry Footprint
    if (paths.length > 0) {
        // Gantry is centered on the current tool position (cur) or the active path position
        let gantryCenter = cur;
        if (activePathIndex >= 0 && activePathIndex < paths.length) {
            gantryCenter = paths[activePathIndex].to;
        }

        const gantryX = gantryCenter.x - gantryW / 2;
        const gantryY = gantryCenter.y + gantryH / 2; // Top-Left of gantry in machine space (since Y is up, top is gantryCenter.y + height/2)

        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)'; // Premium translucent red/coral
        ctx.lineWidth = 1.5;

        const gantryX_canvas = mapX(gantryX);
        const gantryY_canvas = mapY(gantryY);

        ctx.strokeRect(gantryX_canvas, gantryY_canvas, gantryW * scale, gantryH * scale);

        // Draw gantry fill (very light glassmorphic red)
        ctx.fillStyle = 'rgba(239, 68, 68, 0.04)';
        ctx.fillRect(gantryX_canvas, gantryY_canvas, gantryW * scale, gantryH * scale);

        // Draw Knife / Tool center dot
        ctx.fillStyle = '#ef4444'; // Bright Red
        ctx.beginPath();
        ctx.arc(mapX(gantryCenter.x), mapY(gantryCenter.y), 4, 0, 2 * Math.PI);
        ctx.fill();

        // Draw gantry labels
        ctx.fillStyle = '#ef4444';
        ctx.font = '9px ui-monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`Gantry (${gantryW}x${gantryH}mm)`, mapX(gantryCenter.x), mapY(gantryY) - 5);
        ctx.fillText("Knife (Center)", mapX(gantryCenter.x), mapY(gantryCenter.y) - 8);

        ctx.restore();
    }

    // Empty State
    if (paths.length === 0) {
        ctx.fillStyle = '#9ca3af';
        ctx.textAlign = 'center';
        ctx.setLineDash([]);
        ctx.fillText("No paths found", canvas.width/2, canvas.height/2);
    }
}