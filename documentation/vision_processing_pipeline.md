# Computer Vision Toolpath Pipeline

This document explains the standard image-to-vector pipeline used in UrumiCutter to convert raster images (like photos or scanned drawings) into physical CNC toolpaths. 

The pipeline consists of three sequential steps: **Skeletonization → Curve smoothing → Point simplification**.

## 1. Skeletonization (Finding the "Centerline")
When a physical drawing is captured via camera (like UrumiCam) or scanned, the resulting lines are thick clusters of pixels. To a CNC cutter, a thick line is ambiguous—should the blade travel down the left edge, the right edge, or the middle?

**Skeletonization** is an algorithm that digitally "eats away" the outer edges of a thick shape until only a stick-figure skeleton remains, exactly **1 pixel wide** down the geometric center. It converts a "thick area" into a "single path".

*   **Implementation in Codebase:** UrumiCutter uses Lingdong Huang's `TraceSkeleton` algorithm. This is implemented both on the Python backend (`UrumiCam/server/skeletonify.py`) and on the JavaScript frontend (`src/trace_skeleton.js`).

## 2. Curve Smoothing (Fixing the "Staircases")
Because screens use a grid of square pixels, a diagonal 1-pixel-wide skeleton is not actually straight—it looks like a jagged staircase (aliasing). 

If you feed these raw staircase steps to a CNC machine, the motors will violently vibrate as they attempt to execute hundreds of microscopic 90-degree corners, ruining the cut quality. 
**Curve Smoothing** takes that jagged pixel path and fits elegant mathematical curves over it. It transforms rigid, grid-locked pixels into fluid, sweeping vectors.

*   **Implementation in Codebase:** The application uses **Chaikin curve smoothing**. This logic is located in the `smoothPolyline` function inside `src/CanvasEditor.js` and `smoothClosedPolyline` in `src/FileHandler.js`.

## 3. Point Simplification (Cleaning up the Data)
Converting pixels into mathematical curves often generates an excessive amount of data. For example, the software might place 500 individual points along a perfectly straight line.

Sending 500 redundant points to a CNC microcontroller will overflow its memory buffer, causing the machine to stutter or stall. 
**Point Simplification** analyzes the path and deletes all unnecessary, redundant points while keeping the overall shape intact within a defined mathematical tolerance. It recognizes that a straight line only requires 2 points (a start and an end) and discards the rest.

*   **Implementation in Codebase:** UrumiCutter uses the industry-standard **Ramer-Douglas-Peucker (RDP)** algorithm. This is heavily utilized via the `simplifyRdp()` function in `src/script.js` and `src/FileHandler.js`. The aggressiveness of this simplification is user-controllable via the `visionSimplifySlider` in the UI.
