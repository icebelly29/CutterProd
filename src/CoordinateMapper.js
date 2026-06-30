/**
 * ============================================================================
 *               CENTRALIZED COORDINATE TRANSFORMATIONS
 * ============================================================================
 *
 * Maps between physical machine space and logical canvas space.
 *
 * Machine Space:
 * - Origin (0,0) is at Bottom-Left (First Quadrant)
 * - +X goes Right
 * - +Y goes Up
 * - Units in mm
 *
 * Canvas Space:
 * - Origin (0,0) is at Top-Left
 * - +X goes Right
 * - +Y goes Down
 * - Units in pixels
 * ============================================================================
 */

export class CoordinateMapper {
    /**
     * Converts machine coordinates (Bottom-Left based) to canvas rendering space.
     * With a bottom-left canvas (scale 1, -1 and translated), machine coordinates naturally 
     * map without needing manual subtraction.
     * @param {number} mx Machine X coordinate (mm)
     * @param {number} my Machine Y coordinate (mm)
     * @param {number} scale Zoom scale (pixels per mm)
     * @param {number} offsetX Pan offset X (pixels)
     * @param {number} offsetY Pan offset Y (pixels)
     * @returns {{x: number, y: number}} Transformed coordinate for inverted canvas context
     */
    static machineToCanvas(mx, my, scale, offsetX, offsetY) {
        return {
            x: (mx * scale) + offsetX,
            y: (my * scale) + offsetY
        };
    }

    /**
     * Maps raw browser mouse coordinates directly to machine space.
     * We calculate the physical pixel by subtracting from the canvas dimensions first,
     * then applying pan and zoom offsets.
     * @param {number} clientX Raw browser offsetX (pixels from left)
     * @param {number} clientY Raw browser offsetY (pixels from top)
     * @param {number} canvasW Canvas width
     * @param {number} canvasH Canvas height
     * @param {number} scale Zoom scale (pixels per mm)
     * @param {number} offsetX Pan offset X (pixels)
     * @param {number} offsetY Pan offset Y (pixels)
     * @returns {{x: number, y: number}} Machine coordinate (mm)
     */
    static pointerToMachine(clientX, clientY, canvasW, canvasH, scale, offsetX, offsetY) {
        // Step 1: Map raw pointer coordinates to match Bottom-Left origin
        const physicalX = clientX;
        const physicalY = canvasH - clientY;

        // Step 2: Remove pan and scale to get raw machine mm
        return {
            x: (physicalX - offsetX) / scale,
            y: (physicalY - offsetY) / scale
        };
    }

    /**
     * Converts top-left coordinate origin to Machine Bottom-Left origin
     * Used exclusively for legacy bounding boxes and SVG exporting mapping
     */
    static machineToTL(mx, my, bedW, bedH) {
        return {
            x: mx,
            y: bedH - my
        };
    }
}
