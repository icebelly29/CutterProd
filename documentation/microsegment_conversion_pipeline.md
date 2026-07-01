# UrumiCutter: SVG to MicroSegment Conversion Pipeline

Based on the `svg-trajectory-converter/index.js` module, the conversion from the shapes and drawings on the UI into microsegments happens through a sophisticated, 7-stage custom geometry engine and motion planning pipeline. 

Instead of traditional ASCII G-Code, this pipeline streams data as **MicroSegments**—highly optimized, 26-byte binary packets—directly to the machine. 

Here is how the UI translates visual vectors into hardware motor movements step-by-step:

## 1. Shape Normalization ("The Standardizer")
SVG elements can be messy (circles, rects, lines, paths). The engine first normalizes everything into a **Unified Path format**:
*   **Circles/Ellipses** are approximated into 4 precise Cubic Bezier curves using a magic constant (`0.552284`) for 99.9% accuracy.
*   **Rectangles** are converted into a simple sequence of 4 Linear commands.
*   The raw SVG `d` string commands (like `M10,20 L30,40`) are then parsed into mathematical coordinate objects. Shorthand (relative) SVG commands are flattened into absolute (global) coordinates.

## 2. Curve Flattening & Arc-Length Parameterization 
Unlike simple graphics renderers, a CNC machine needs precise, equidistant points (not just "smooth-looking" points).
*   **Straight lines:** Are mathematically subdivided into chunks matching your `segmentLength` setting.
*   **Curves (Cubic Beziers):** The engine builds an Arc-Length Parameterization Look-Up Table (LUT). It calculates the exact physical distance along the curve and outputs a coordinate every `segmentLength` millimeters, completely ignoring the generic parameter `t`. This ensures the machine maintains a constant velocity through the curve. *(See section below for a deeper dive)*

## 3. Coordinate Transformation Pipeline
Before a coordinate number becomes raw data, it gets filtered through a 4-stage engine based on your machine configurations:
*   **Scale:** SVG pixels are scaled to real-world millimeters.
*   **Inversion/Flip:** Corrects axis differences (e.g., flipping Y because screens render top-down while the machine coordinates are bottom-up, or fixing the X-axis inversion of the physical hardware).
*   **Offset:** Shifts the drawing relative to the center of the physical machine bed.
*   **Rounding:** Truncates to 4 decimal places for precision without bloat.

## 4. Kinematics & Velocity Calculations
At every single microscopic point, the engine calculates the first derivative of the Bezier function `B'(t)`. This evaluates the instantaneous velocity vectors `Vx` and `Vy`, ensuring the motion planner knows the exact direction and speed needed to maintain fluid motion without stalling or stuttering.

## 5. Tangential Knife Support (Z-Hops)
Because UrumiCutter utilizes a tangential knife, the system automatically computes a physical target heading (Angle, or A-axis) using `atan2(dy, dx)`.
*   The engine performs a shortest rotational difference test. 
*   If a corner's heading change exceeds your `angleThreshold` (e.g., a sharp 90-degree turn), the system automatically injects a sequence to lift the tool (Z-Up), orient the blade to the new angle in mid-air, and plunge back down (Z-Down). This prevents the blade from tearing the material.

## 6. Binary MicroSegment Encoding
Once the absolute `(X, Y, Z, A)` coordinates for a point are calculated, the engine computes the relative delta (difference in steps) from the *previous* point and passes it to the `packMicrosegment()` function. 

This packages the data into a **26-byte binary packet** (a "MicroSegment"):
*   **Byte 0:** Start byte `0xAB`
*   **Bytes 1-16:** Four signed 32-bit integers representing relative motor step deltas (`dX, dY, dZ, dA`)
*   **Bytes 17-20:** A 32-bit timer interval (determines exactly how fast this segment executes using a 150 MHz timer)
*   **Byte 21-24:** Flags, sequence counter, and reserved bytes
*   **Byte 25:** A CRC-8 checksum to validate data integrity

These 26-byte packets are collected into an array and streamed serially to the microcontroller firmware, which steps the physical motors in perfect synchrony.

---

# Deep Dive: Arc-Length Parameterization Look-Up Table (LUT)

To understand why the **Arc-Length Parameterization Look-Up Table (LUT)** is necessary, we first have to look at how curves are drawn mathematically and why that creates a huge problem for physical CNC machines.

## The Problem: The Rubber Band Effect
SVG curves are defined by **Bezier formulas**. To find a point on the curve, you plug in a parameter called **`t`** (time), which always goes from `0.0` (start of the curve) to `1.0` (end of the curve). 

If you want to chop the curve into 10 pieces, the logical approach is to increase `t` by `0.1` (`t=0.0, 0.1, 0.2...`). 

However, Bezier curves act like a rubber band. Depending on where the control points are placed, the "speed" of `t` changes drastically:
*   Increasing `t` from `0.0` to `0.1` might move the physical blade **2mm**.
*   Increasing `t` from `0.5` to `0.6` might move the physical blade **20mm**.

For a web browser rendering pixels, this rubber band effect doesn't matter. But for a physical CNC machine, it is disastrous. If you just step `t` evenly, your motors will accelerate violently in the middle of a curve and abruptly slow down at the ends. The machine will stutter, stall, and ruin the material.

## The Solution: Arc-Length Parameterization
We need a way to say: *"I don't care about `t`. Give me the exact coordinate that is exactly 1.0mm further along the curve from my current position."*

Converting a desired physical distance into the correct `t` value requires complex calculus (integrals) that are too slow to compute in real-time. Instead, we use a **Look-Up Table (LUT)** as a highly efficient cheat sheet.

Here is how the LUT is built and used in the UrumiCutter codebase:

### 1. Building the Table (Sampling)
Before the machine starts moving, the system breaks the curve into many microscopic, even steps of `t` (e.g., 100 steps). 
It walks along these tiny steps and calculates the actual, physical straight-line distance (using the Pythagorean theorem) from point to point, keeping a running total.

It builds a table that looks like this:

| `t` value | Accumulated Physical Distance |
| :--- | :--- |
| `0.00` | 0.00 mm |
| `0.01` | 0.12 mm |
| `0.02` | 0.35 mm |
| ... | ... |
| `0.45` | 15.00 mm |
| `0.46` | 16.00 mm |

### 2. Looking Up the Correct `t`
When the motion planner is generating MicroSegments, it says: *"I need to place a point exactly **15.50 mm** along this curve."*

1.  It scans down the `Accumulated Physical Distance` column of the LUT.
2.  It finds that `15.50 mm` falls exactly halfway between row `0.45` (15.00mm) and row `0.46` (16.00mm).
3.  It mathematically blends (interpolates) the two rows to guess that the perfect `t` value must be **`0.455`**.

### 3. The Result: Constant Velocity
The system takes that exact `t = 0.455`, plugs it back into the Bezier formula, and gets the perfect `(X, Y)` coordinate. 

Because of this LUT, every single MicroSegment sent to the hardware is exactly your `segmentLength` apart. Your stepper motors will spin at a beautifully consistent, smooth velocity throughout the entire curve, resulting in perfect cuts without jerking.
