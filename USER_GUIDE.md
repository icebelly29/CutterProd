# CutterProd & UrumiCam: Complete User Guide

Welcome to the comprehensive user guide for the CutterProd CNC control platform and the UrumiCam vision system. This guide will walk you through every feature step-by-step, from launching the application to executing your first precise cut.

---

## 1. Getting Started

### Launching the Application
The entire suite is launched with a single command from your terminal.

1. Open your terminal and navigate to the project directory:
   ```bash
   cd CutterProd
   ```
2. Start the application:
   ```bash
   npm start
   ```
   *Note: This command spins up both the frontend Node server (port 3000) and the backend Python Flask server (port 5000).*

3. Open your Chromium-based web browser (Google Chrome or Microsoft Edge) and navigate to:
   **http://localhost:3000**

---

## 2. Interface Overview

The CutterProd interface is divided into functional tabs. You can navigate between them using the top navigation bar:

*   **Control (Home):** The main dashboard for loading files, connecting to hardware, manual jogging, and monitoring job progress.
*   **Draw:** A full-featured interactive 2D CAD environment where you can draw shapes, bezier curves, and manipulate imported SVGs on a virtual cutter bed.
*   **Preview:** Visualizes the generated motor trajectory (the toolpath) before you cut.
*   **UrumiCam:** Opens the integrated computer-vision interface in a new browser tab for bed scanning and material edge detection.

---

## 3. Connecting the Hardware

Before you can move the gantry or cut, you must connect the browser to your Raspberry Pi Pico microcontroller.

1. Go to the **Control** tab.
2. Ensure your Raspberry Pi Pico is plugged into your PC via USB.
3. Click the **Connect Serial** button.
4. A browser popup will appear. Select the `USB Serial Device` (or the COM port associated with your Pico) and click **Connect**.
5. Once connected, the status badge will change to a green `Connected` state.

---

## 4. Configuring the Machine

You must configure your machine's physical limits and motor parameters to ensure safe and accurate movement.

1. On the **Control** tab, click the **Settings** button (gear icon) to open the configuration modal.
2. **Bed Dimensions:** Set your physical bed width (`bedW`) and height (`bedH`) in millimetres. This is critical as the system will strictly prevent the cutter from moving outside these bounds.
3. **Axis Settings:** For each axis (X, Y, Z, A):
    *   Set the `RS485 ID` of the motor driver.
    *   Set the `Steps per mm` (or `Steps per rev` for rotary axes) based on your hardware's microstepping configuration.
4. **CAM Settings:**
    *   **Segment Length:** The resolution at which curves are mathematically flattened (e.g., `0.1 mm`).
    *   **Cut Speed (SPS):** Your default cutting speed in Steps-Per-Second.
    *   **Sharp Corner Threshold:** The angle degree at which the drag knife will auto-lift and rotate (e.g., `30` degrees).
5. Click **Close**. Settings are saved automatically.

---

## 5. Designing the Cut (The Draw Tab)

The Draw tab is your virtual workbench. It perfectly represents your physical cutting bed.

### Basic Drawing Tools
Use the toolbar on the left or keyboard shortcuts to create geometry:
*   **Select (V):** Click shapes to select them, drag to move them. Drag a selection box over empty space to select multiple shapes at once. Press `Delete` to remove selected shapes.
*   **Pencil (P):** Click and drag to draw freehand paths.
*   **Line (L):** Click and drag to draw a straight line.
*   **Rectangle (R):** Click and drag to draw an axis-aligned rectangle.
*   **Ellipse (E):** Click and drag to draw ellipses or circles.
*   **Bezier (B):** Creates smooth, complex curves using 4 clicks:
    1.  Click the starting point.
    2.  Click the first control point.
    3.  Click the second control point.
    4.  Click the endpoint.
*   **Eraser (X):** Click on any line or shape to delete it.

### Importing External SVGs
You can import existing designs:
1.  Drag and drop an `.svg` file directly onto the **Control** tab or the **Draw** canvas.
2.  Imported SVGs can be moved, selected, or edited using the Draw tools.

### Exporting to Trajectory
Once your design is ready:
1. Click the **Send to Cutter** button in the Draw tab.
2. The system automatically converts all your shapes into G-code-style trajectories and switches you to the **Preview** tab.

---

## 6. Using UrumiCam (Computer Vision)

UrumiCam helps you map the physical materials on your bed into the digital software so you can cut precisely on scrap or misaligned materials.

Click the **UrumiCam** link in the top navigation bar to open the vision dashboard.

### Phase 1: Camera Calibration
Before your first scan, calibrate the camera to ensure digital millimetres perfectly match physical millimetres.
1. Place a physical **ArUco Marker (ID 0 from the 4x4 dictionary)** measuring exactly **20mm x 20mm** near the center of the bed's camera view.
2. In the UrumiCam UI, open the **Settings** panel.
3. Scroll to the **Calibration** section and click **ArUco Calibrate**.
4. The camera will capture a frame, detect the marker, and calculate the exact pixel-to-mm scale and Field of View (FOV).
5. You will see a success message (e.g., `Successfully calibrated: 50.7000 px/mm`) in the system log. The calibration is permanently saved.

### Phase 2: Workpiece Auto-Detection
If you have material on the bed and want to know its exact boundaries:
1. Ensure your gantry is positioned over the bed.
2. In the **ROI Configuration** accordion panel, select the **Auto Detect** tab.
3. Click **Start Scan**.
4. The system will take a photo, analyze the contrast (using Otsu binarization and edge energy), and draw a red bounding box around the detected material.
5. A confirmation window will appear showing the cropped image. Click **Accept ROI** to proceed, or close it to reject.
6. The detected contour is instantly sent back to the CutterProd **Draw** tab as a vector outline, allowing you to draw your cut lines strictly inside the physical material bounds.

### Alternative: Mobile Phone Uploads
If you don't want to use the gantry camera, you can use your smartphone:
1. Place 4 ArUco markers at the known corners of your CNC bed.
2. Take a top-down photo of the bed with your phone.
3. In UrumiCam, navigate to the **Mobile Uploads (Method 2)** section.
4. Upload the photo. The server will detect the corner markers, perfectly flatten the skewed photo, detect the workpiece edges via Canny Edge Detection, and push the SVG to CutterProd.

---

## 7. Execution: Simulating and Cutting

Once your trajectory is prepared (via the Draw tab or SVG import), you are ready to cut.

### Previewing the Job
1. Go to the **Preview** tab.
2. You will see an HTML5 canvas rendering of the toolpath.
    *   **Orange Dots:** Cutting moves.
    *   **Grey Dashed Lines:** Travel moves (Z-axis lifted).
3. The grey square represents the machine's gantry footprint.

### Simulating
To test the flow without moving physical hardware:
1. Go to the **Control** tab.
2. Toggle the **Simulation Mode** switch to the ON position.
3. Click **Start Job**. The system will stream commands internally and update the preview canvas in real-time, coloring executed segments emerald green.

### Running the Physical Job
1. Ensure **Simulation Mode** is OFF.
2. Ensure you have homed or zeroed your machine axes.
3. Click **Start Job**.
4. CutterProd will stream the job line-by-line using smart buffer flow control (`ready` / `nope`).
5. If you need to stop, click **Pause**. When you resume, the machine will safely execute a vertical Z-lift to prevent dragging the blade across the material.

---

## 8. Manual Control (Jogging)

You can manually drive the gantry at any time from the **Control** tab or UrumiCam UI.

1. Locate the **Jog Controls** panel.
2. Select your desired step distance (e.g., `1 mm`, `10 mm`, `50 mm`).
3. Click the directional arrows for the **X** and **Y** axes.
4. Use the vertical arrows for the **Z-axis** (up/down).
5. Use the circular arrows for the **A-axis** (rotation).
6. Click the Home icon to reset all absolute coordinates to zero.

**Keyboard Shortcuts:**
*   `Arrow Keys`: Jog X and Y.
*   `Page Up` / `Page Down`: Jog Z.
*   `[` and `]`: Jog A-axis.
*   `Home`: Set current position as origin (0,0).

---
*Happy Cutting!*
