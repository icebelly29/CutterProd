# WebSerial Trajectory Sender

This application is a browser-based frontend for controlling a CNC/Plotter machine (specifically targeting a Raspberry Pi Pico). It converts SVG vector graphics into highly detailed, segmented trajectory data (`xyz X Y Z Vx Vy Vz Angle`) and streams it over USB via the WebSerial API.

## Features

- **WebSerial Communication**: Directly talk to your Raspberry Pi Pico over USB from your browser. No extra drivers or backend servers needed.
- **Segmented Trajectory Generation**: Instead of generic `G1` commands, paths are subdivided into exact, equal-length segments (user-configurable).
- **Bezier Kinematics & Normalized Speed**: Calculates the pure directional velocity (`Vx`, `Vy`) for every single point and normalizes it to ensure the machine travels at a perfectly consistent user-defined Feedrate (Cutting Speed), regardless of curve lengths.
- **Tangential Knife Support**: Automatically calculates rotational angles for every segment and inserts Z-lift/plunge sequences for sharp corners based on an angle threshold.
- **Fully Relative Coordinate System**: The trajectory engine outputs Relative Step Changes for *all* axes (X, Y, Z, and Angle). This ensures clean delta moves for the Pico firmware and prevents sending redundant zero-velocity data.
- **Safe Retract on Restart**: If a job is interrupted, the UI remembers the machine's exact last known location. Upon restarting, it dynamically injects a pure vertical lift command to safely retract the pen *before* moving to the job's starting point, completely preventing diagonal drag crashes.
- **Smart Buffer Management**: Fully handles Pico hardware buffer limits. If the firmware replies with `nope` (buffer full), the UI pauses and waits for the Pico to send a `ready` signal before automatically resuming the stream, ensuring massive files stream seamlessly without hanging or flooding the serial port.

---

## Setup & How to Run

Because this application uses the **WebSerial API**, modern browsers enforce strict security rules:
**You cannot double-click the `index.html` file to run it.** It must be served over a secure context (`https://` or `localhost`).

### Running Locally (Recommended)

You need to start a simple local web server in this folder. 

**Using Node.js:**
1. Open your terminal/command prompt.
2. Navigate to this folder (`data/`).
3. Run: `npx serve`
4. Open your web browser and go to the `localhost` URL provided in the terminal.

---

## How to Use

1. **Connect the Machine:**
   - Plug your Raspberry Pi Pico into your computer via USB.
   - Click the **Connect Serial** button in the top right.
   - A browser popup will appear. Select the COM port corresponding to your Pico and click "Connect".

2. **Machine Configuration (⚙️ Settings):**
   - Click the **Settings** button in the toolbar to open the Machine Configuration Modal.
   - Adjust the **Segment Length (mm)** to change the resolution of your trajectory points.
   - Dial in your **Cutting Speed (mm/sec)**. The UI will normalize all velocity vectors and apply this target feedrate globally.
   - Configure your stepper hardware: **Motor Steps per Rev**, **Microstepping**, and **mm per Revolution** for the X/Y axes. 
   - Set dedicated values for **Z-Axis Steps per MM** and **Rotary Steps per Degree** to ensure perfect scaling across all distinct mechanical systems.

3. **Load a File:**
   - Drag and drop an `.svg` file onto the "Trajectory Preview" window, or click **Load File**.
   - The application automatically scales the vector to fit your machine bed (230x310mm), flips the Y-axis (to match CNC standard coordinates), and converts it into pure integer CSV trajectory data prefixed with `xyz`.

4. **Review & Start Cutting:**
   - **Trajectory Preview Tab:** See exactly what the machine will draw. The visualizer parses the relative Z outputs to draw blue paths for Pen-Down moves and grey dashed paths for Pen-Up travels.
   - Once ready, click **Start**. The app streams the file line-by-line, perfectly coordinating with the Pico's `ok` and `nope` signals!

5. **Manual Control (🕹️ Jog):**
   - Click the **Jog** button to open the manual control overlay.
   - Use the D-Pad for **X/Y** movement.
   - Use the vertical buttons for **Z-Axis** (Up/Down) and **Rotary Axis** (CW/CCW).
   - **Keyboard Shortcuts:**
     - `Arrow Keys`: Move X and Y.
     - `Page Up / Page Down`: Move Z axis.
     - `[ / ]` (Brackets): Rotate A axis.
     - `Home`: Command the machine to go to zero (`home`).

---

## The Output Format

The engine generates data mapped strictly to **Steps** and pure **Integers** (no decimals) to optimize firmware parsing. 

The very first line sent is always `enable all 1` to engage the stepper drivers. Every subsequent line follows this format:

`move <count> <RS485 IDs> <steps> <SPS>`

**Example:** `move 4 3 2 1 4 10 10 10 10 500 500 500 500`

- `move`: Command identifier.
- `<count>`: Number of motors moving in this segment.
- `<RS485 IDs>`: Space-separated list of motor IDs (e.g. `3 2 1 4`).
- `<steps>`: Signed relative steps for each motor.
- `<SPS>`: Steps-Per-Second (velocity) for each motor, calculated to ensure synchronous arrival.

- **xyz**: The required prefix identifier. (Legacy, now replaced by `move`)
- **X, Y**: The *Relative* change in target coordinates (in Steps).
- **Z**: The *Relative* change in Z Steps (e.g. `6400` to plunge, `-6400` to lift).
- **Vx, Vy, Vz**: The normalized velocity vector in Steps/sec.
- **Angle**: The *Relative* change in Tangential Knife angle (in Steps, calculated from Steps per Degree).

---

## Commands Reference

| Command | Description | Format |
| :--- | :--- | :--- |
| **move** | Trajectory segment / Manual Jog | `move <count> <ids...> <steps...> <sps...>` |
| **home** | Move all axes to zero | `home` |
| **enable** | Enable/Disable motors | `enable all <0/1>` |
