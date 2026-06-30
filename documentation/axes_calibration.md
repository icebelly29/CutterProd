# UrumiCutter Axes Calibration Guide

This document explains how to manually invert or un-invert the X and Y axes for the UrumiCutter machine. Because the software needs to maintain parity between the physical gantry movement and the UI trajectory preview, axis inversion requires changing the coordinate signs in exactly **four different places** across the codebase.

## How to Invert or Un-invert an Axis

To change the direction of an axis, you must either add a `-` (minus sign) to invert it, or remove the `-` sign to return it to normal. 

**Important:** You must make the exact same change in all 4 of the following locations to ensure the physical machine matches the UI display.

---

### 1. The Core Trajectory Generator (Physical Machine)
This controls the actual trajectory packets generated from SVG paths and sent to the firmware.

* **File:** `svg-trajectory-converter/index.js`
* **Location:** Inside the `packMicrosegment` function (around line 94)

```javascript
    view.setInt32(1, -dx, true); // <-- X axis (remove the minus to un-invert)
    view.setInt32(5, -dy, true); // <-- Y axis (remove the minus to un-invert)
```

> [!WARNING]
> Because of the `start.js` setup, after you edit `svg-trajectory-converter/index.js`, you **MUST completely restart your server** (`Ctrl+C` then `npm start`). The start script will automatically rebuild the package and copy the updated logic to `src/SvgConverter.js` for you.

---

### 2. The Manual Jog Buttons (Physical Machine)
This controls the physical movement when you click the manual "Move/Jog" buttons in the UI.

* **File:** `src/BinaryUtils.js`
* **Location:** Inside the `packMicrosegment` function (around line 49)

```javascript
    view.setInt32(1, -dx, true); // <-- X axis
    view.setInt32(5, -dy, true); // <-- Y axis
```

---

### 3. The Trajectory Preview (UI Display)
This logic un-inverts the hardware packets so that the generated toolpath lines draw right-side-up on your screen instead of shooting off the canvas.

* **File:** `src/Viewer.js`
* **Location:** Inside the WebWorker packet decoding loop (around line 266)

```javascript
            const dx = -view.getInt32(1,  true); // <-- X axis
            const dy = -view.getInt32(5,  true); // <-- Y axis
```

---

### 4. The Live Coordinate Readout (UI Display)
This logic un-inverts the packets to display the correct numerical X and Y text values in the UI dashboard.

* **File:** `src/script.js`
* **Location:** Inside the `updatePositionFromPacket` function (around line 326)

```javascript
    const dx = -view.getInt32(1, true); // <-- X axis
    const dy = -view.getInt32(5, true); // <-- Y axis
```

---

## Testing Workflow

Once you have added or removed the minus signs for the axis you want to change:
1. Save all edited files.
2. Restart the Node server (`Ctrl+C` -> `npm start`).
3. Hard refresh your browser (`Ctrl+F5`).
4. Load the `calibration_test.svg` file and verify both the trajectory preview and the physical machine movement.
