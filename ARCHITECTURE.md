# CutterProd & UrumiCam: Detailed System Architecture & Workflow

This document provides a comprehensive, deep-dive explanation of the entire software ecosystem. It covers how the frontend (CutterProd), the backend vision system (UrumiCam), and the hardware (Raspberry Pi Pico & CNC gantry) interact, as well as the detailed algorithmic flow from drawing/scanning to physical machine movement.

---

## 1. High-Level System Overview

The system is split into two primary software components that run concurrently and communicate with each other and the hardware:

1. **CutterProd (Frontend - Node.js/Vanilla JS)**
   * **Role:** The main user interface, CAD/CAM engine, and machine controller.
   * **Hardware Connection:** Communicates directly with the Raspberry Pi Pico microcontroller via **WebSerial** (USB).
   * **Core Loop:** Parses SVGs, generates segmented motor trajectories, and streams raw motor step commands to the Pico while managing buffer flow control.

2. **UrumiCam (Backend - Python/Flask)**
   * **Role:** The computer vision and gantry scanning engine (designed to run on a Raspberry Pi 4B).
   * **Hardware Connection:** Communicates with the Raspberry Pi Pico via **UART** to move the gantry during automated camera scanning.
   * **Core Loop:** Captures high-res photos, performs OpenCV-based workpiece edge detection, ArUco calibration, and image stitching. It pushes the final detected contours as SVGs to the CutterProd frontend over HTTP.

---

## 2. The CAD/CAM Pipeline (Frontend)

The journey from a digital shape to a physical cut happens entirely in the browser using the frontend components.

### Step 1: Shape Input (`CanvasEditor.js` & `FileHandler.js`)
* **Vector Drawing (`CanvasEditor.js`):** Users can draw paths, rectangles, ellipses, and Bézier curves directly on a canvas mapped 1:1 to the physical bed dimensions (`bedW`, `bedH`). Drawn shapes are converted natively to SVG `<path>` elements.
* **File Import (`FileHandler.js`):** Users can drag-and-drop external SVG files. The handler parses the SVG and applies automatic scaling to fit the bed, *unless* the SVG is tagged as originating from the internal canvas (`data-source="canvas"`), in which case it maintains a pixel-perfect 1:1 physical match.

### Step 2: Trajectory Compilation (`SvgConverter.js`)
This is the core CAM engine. It translates abstract SVG geometry into a rigid, sequential array of physical coordinate points.
* **Primitive Parsing:** It converts basic shapes (`<rect>`, `<circle>`, `<polygon>`, `<line>`) into equivalent path commands (`M`, `L`, `C`).
* **Bézier Flattening (Kinematics):** Cubic (`C`) and Quadratic (`Q`) Bézier curves cannot be fed directly to motors. The converter mathematically "flattens" these curves by calculating points along the curve at fixed, tiny segment lengths (e.g., 0.1 mm resolution). This ensures that the cutter maintains a **constant velocity (feedrate)** through complex curves.
* **Boundary Clamping:** Every generated `(X, Y)` point is strictly clamped between `[0, bedW]` and `[0, bedH]`. This hard-coded safety guard mathematically prevents the CNC from attempting to crash into the physical frame.
* **Tangential Knife Logic:** If the machine uses a drag knife, the engine looks at the angle between two consecutive segments. If the angle exceeds a configurable threshold (a "sharp corner"), it injects a sequence to:
  1. Lift the Z-axis.
  2. Rotate the A-axis (blade angle) to the new tangent.
  3. Plunge the Z-axis back into the material.

### Step 3: Machine Streaming (`script.js` & `Connection.js`)
* **Relative Steps:** The continuous array of physical `(X, Y, Z, A)` coordinates is converted into **signed relative motor steps** based on the configured `steps_per_mm` for each axis.
* **Synchronous Arrival (SPS):** For every multi-axis move (e.g., moving X by 1000 steps and Y by 500 steps), the engine calculates independent Steps-Per-Second (SPS) velocities for each motor so that they all arrive at the destination at the exact same millisecond.
* **Flow Control (`ready` / `nope`):** The Pico has limited memory. `script.js` streams the commands block-by-block. If the Pico replies with `nope`, the frontend pauses streaming until the Pico finishes a move and replies `ready`, ensuring the buffer never overflows during large, hours-long jobs.

---

## 3. The Vision System Pipeline (UrumiCam Backend)

UrumiCam handles the automatic detection of physical materials (workpieces) placed on the cutting bed.

### A. ArUco Marker Calibration (`calibration.py`)
Before scanning, the camera needs to understand physical space.
1. The user places a standard **ArUco Marker (ID 0, DICT_4X4_50)** of exactly **20mm** size on the bed.
2. The user clicks **ArUco Calibrate** in the UI.
3. The Flask server captures a frame and uses OpenCV to detect the 4 corners of the marker.
4. It calculates the average Euclidean distance (in pixels) of the marker's edges.
5. **Math:** 
   * `pixels_per_mm = average_edge_px / 20.0`
   * `tile_fov_x_mm = frame_width / pixels_per_mm`
   * `tile_fov_y_mm = frame_height / pixels_per_mm`
6. These exact Field of View (e.g., 40x30mm) and scaling metrics are saved to `config.json` for precise spatial mapping.

### B. Workpiece Auto-Detection (Method 1)
For materials already on the bed, UrumiCam automatically finds their boundaries so you don't cut off the edge.
1. **State Machine (`state_machine.py`):** The scan starts and the engine transitions from `IDLE` to `ROI_SCAN`.
2. **Image Capture:** The gantry camera captures a wide-context overview frame of the bed.
3. **4-Stage Cascade Segmentation (`roi_detector.py`):**
   * *Stage 1 (Otsu Thresholding):* Evaluates the image histogram. If it is bimodal (distinct dark material vs. light bed), it uses Otsu's method to cleanly binarize the image.
   * *Stage 2 (Edge Energy):* If Otsu fails (low contrast), it falls back to calculating edge-energy projections to find the bounding box.
   * *Stage 3 (Contour Filtering):* It finds the largest valid contour in the binary mask, representing the workpiece.
   * *Stage 4 (Expansion & Conversion):* It expands the bounding box by a safety margin and converts pixel coordinates into physical `(X, Y)` millimetres using the calibrated `pixels_per_step`.
4. **Interactive Confirmation:** The detected bounding box is shown to the user on the frontend. Once accepted, the state machine triggers the gantry to move and scan that specific area.

### C. Mobile Discovery (Method 2)
If the user uploads a photo of the bed taken from their smartphone:
1. **Homography (`aruco_rectifier.py`):** OpenCV detects 4 ArUco markers placed at the known physical corners of the CNC bed. It calculates a homography matrix to mathematically warp, flatten, and de-skew the angled smartphone photo into a perfectly top-down, physically-scaled 2D map.
2. **Canny Edge Detection:** The flattened image runs through Canny edge detection to trace the exact outlines of the workpiece.
3. **SVG Export:** The pixel contours are mapped to physical mm coordinates and exported as an SVG file directly into CutterProd's drawing canvas.

---

## 4. Hardware Interaction (Pico & UART/WebSerial)

* **Dual Interface:** The Pico listens to the PC browser via **USB WebSerial** (for high-speed job cutting) and to the Raspberry Pi 4B via **UART** (for automated camera jogging during scans).
* **Command Syntax:** All movement uses a strictly formatted string:
  `move <count> <RS485 IDs...> <steps...> <SPS...>`
  *(e.g., `move 2 1 3 1600 3200 8000 16000` means move motors 1 and 3 by 1600 and 3200 steps at 8kHz and 16kHz velocities).*
* **Execution:** The Pico receives this, engages the requested RS485 stepper drivers, pulses the hardware pins at the calculated frequencies, and physically drives the gantry.

---

## 5. End-to-End User Workflow Summary

1. **Setup & Calibrate:** Place ArUco marker -> click **ArUco Calibrate**. System learns the camera's true FOV and mm-to-pixel scale.
2. **Detect Workpiece:** Place material on the bed -> click **Auto Detect**. Camera captures the bed, Otsu segmentation finds the material edges, and prompts for confirmation.
3. **Scan (Optional):** Gantry physically drives a grid pattern over the detected ROI, stitching a high-res mosaic map of the material.
4. **Design:** The stitched map or detected edges are loaded into the **Draw** tab. The user uses the Bézier and line tools to draw the desired cut path precisely over the material graphics.
5. **Compile & Cut:** User clicks **Send to Cutter**. `SvgConverter.js` flattens the curves, clamps to bed limits, generates the relative motor step commands, and `script.js` streams them to the Pico over WebSerial. The motors spin, and the part is cut.
