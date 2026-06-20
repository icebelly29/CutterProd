/**
 * ============================================================================
 *                         SVG TO TRAJECTORY CONVERTER
 * ============================================================================
 *
 * This module is a custom-built geometry engine designed to translate complex
 * vector mathematics into segmented trajectories for real-time machine control.
 *
 * 1. THE GEOMETRY ENGINE (Vector2 & CubicBezier)
 *    SVG drawings aren't just lists of points; they are mathematical formulas.
 *    - Vector2: Handles the heavy lifting of 2D math (addition, subtraction,
 *      normalization, and distance checking).
 *    - CubicBezier: Implements the Bernstein Polynomial formula. This formula
 *      allows us to calculate the exact coordinate (x,y) along a curve at any
 *      parameter 't' (where t=0 is the start and t=1 is the end).
 *
 * 2. SHAPE NORMALIZATION (The "Standardizer")
 *    SVG is messy — it has circles, rects, and paths. We convert EVERYTHING into
 *    a "Unified Path" format.
 *    - Circles are converted into 4 Cubic Bezier curves using a magic constant
 *      (0.552284), which approximates a circular arc with 99.9% accuracy.
 *    - Rectangles are converted into a sequence of 4 Linear commands.
 *
 * 3. THE PATH TOKENIZER (Parsing)
 *    SVG path strings (the 'd' attribute) look like "M10,20 L30,40".
 *    Our parser:
 *    - Tokenizes: Splits numbers from letters.
 *    - State Tracking: Remembers the "Last Command" to support SVG's shorthand.
 *    - Relative vs Absolute: Converts lower-case commands (relative) into
 *      global coordinates by adding them to the current pen position.
 *
 * 4. CURVE FLATTENING & EQUAL-LENGTH SEGMENTATION
 *    Instead of generic G1 moves, we require precise, equidistant trajectory points.
 *    - Straight lines: Subdivided mathematically into chunks matching `segmentLength`.
 *    - Curves: We build a Look-Up Table (LUT) mapping parameter 't' to actual
 *      physical distance (Arc-Length Parameterization). We use this LUT to
 *      guarantee that every emitted point along a curve is exactly `segmentLength`
 *      millimeters apart, rather than equal-time 't' apart.
 *
 * 5. KINEMATICS & VELOCITY CALCULATIONS
 *    For advanced control (e.g., Look-Up Table kinematics), the machine needs
 *    to know its intended velocity vector at every point.
 *    - We evaluate the first derivative of the Bezier function: B'(t).
 *    - This calculates the exact instantaneous velocity components (Vx, Vy) at
 *      any point on the curve, ensuring smooth motion planning.
 *
 * 6. COORDINATE TRANSFORMATION PIPELINE
 *    Before a number becomes data, it goes through a 4-stage filter:
 *    1. Scale: Convert SVG units to real-world millimeters.
 *    2. Flip Y: Vertical inversion (Screen Y-down vs Machine Y-up).
 *    3. Offset: Shifting the drawing to the center of the physical bed.
 *    4. Rounding: Truncating to 4 decimal places for precision without bloat.
 *
 * 7. TANGENTIAL KNIFE SUPPORT
 *    The trajectory automatically computes a physical target heading (Angle)
 *    using `atan2(dy, dx) * 180 / PI`.
 *    - Shortest Path & Sharp Corners: A shortest rotational difference test is
 *      performed. If the heading change exceeds the `angleThreshold`, the
 *      system automatically executes a sequence to lift the tool (Z-Up),
 *      orient to the new angle, and plunge (Z-Down) to prevent material tearing.
 * ============================================================================
 */

/**
 * @file index.js (svg-trajectory-converter)
 * @description Main entry point and classes for parsing SVG and generating CNC trajectories.
 */

/**
 * Compute CRC-8 using polynomial 0x8C.
 */
function crc8(data) {
    let crc = 0x00;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 0x01) {
                crc = (crc >> 1) ^ 0x8C;
            } else {
                crc >>= 1;
            }
        }
    }
    return crc & 0xFF;
}

/**
 * Pack a MicroSegment into a 26-byte wire packet.
 */
function packMicrosegment(dx, dy, dz, da, interval, flags = 0, seq = 0) {
    const buffer = new ArrayBuffer(26);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);

    view.setUint8(0, 0xAB);
    view.setInt32(1, dx, true);
    view.setInt32(5, dy, true);
    view.setInt32(9, dz, true);
    view.setInt32(13, da, true);
    view.setUint32(17, interval, true);
    view.setUint8(21, flags);
    view.setUint8(22, seq & 0xFF);
    view.setUint8(23, 0);
    view.setUint8(24, 0);

    const crc = crc8(uint8.subarray(0, 25));
    view.setUint8(25, crc);

    return uint8;
}

/**
 * @class Vector2
 * @description Represents a 2D vector with basic arithmetic operations.
 */
class Vector2 {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  add(v) { return new Vector2(this.x + v.x, this.y + v.y); }
  sub(v) { return new Vector2(this.x - v.x, this.y - v.y); }
  mul(s) { return new Vector2(this.x * s, this.y * s); }
  div(s) { return new Vector2(this.x / s, this.y / s); }
  dot(v) { return this.x * v.x + this.y * v.y; }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y); }
  lengthSq() { return this.x * this.x + this.y * this.y; }
  normalize() {
    const l = this.length();
    return l === 0 ? new Vector2(0, 0) : this.div(l);
  }
  dist(v) { return this.sub(v).length(); }
}

/**
 * @class CubicBezier
 * @description Represents a Cubic Bezier curve defined by 4 control points.
 */
class CubicBezier {
  /**
   * @constructor
   * @param {Vector2} p0 - Start point.
   * @param {Vector2} p1 - First control point.
   * @param {Vector2} p2 - Second control point.
   * @param {Vector2} p3 - End point.
   */
  constructor(p0, p1, p2, p3) {
    this.p0 = p0;
    this.p1 = p1;
    this.p2 = p2;
    this.p3 = p3;
  }

  /**
   * @method sample
   * @description Calculates a point on the curve at parameter t using Bernstein polynomials.
   * @param {number} t - Interpolation factor (0.0 to 1.0).
   * @returns {Vector2} The point on the curve.
   */
  sample(t) {
    const t1 = 1 - t;
    const a = t1 * t1 * t1;
    const b = 3 * t1 * t1 * t;
    const c = 3 * t1 * t * t;
    const d = t * t * t;
    return new Vector2(
      a * this.p0.x + b * this.p1.x + c * this.p2.x + d * this.p3.x,
      a * this.p0.y + b * this.p1.y + c * this.p2.y + d * this.p3.y
    );
  }

  /**
   * @method getVelocity
   * @description Calculates the instantaneous velocity vector (First Derivative)
   * of the curve at parameter t.
   *
   * The formula for the derivative of a Cubic Bezier curve B(t) is:
   * B'(t) = 3(1-t)^2*(P1-P0) + 6(1-t)*t*(P2-P1) + 3t^2*(P3-P2)
   *
   * This provides the physical direction and speed vector required for the
   * machine's trajectory planner to maintain smooth, continuous motion.
   *
   * @param {number} t - Interpolation factor (0.0 to 1.0).
   * @returns {Vector2} The velocity vector components (Vx, Vy).
   */
  getVelocity(t) {
      const vel = (p0, p1, p2, p3, t) => {
          const u = 1 - t;
          return 3 * (u ** 2) * (p1 - p0) +
                 6 * u * t * (p2 - p1) +
                 3 * (t ** 2) * (p3 - p2);
      };
      return new Vector2(
          vel(this.p0.x, this.p1.x, this.p2.x, this.p3.x, t),
          vel(this.p0.y, this.p1.y, this.p2.y, this.p3.y, t)
      );
  }

  /**
   * @method getLUT
   * @description Generates a Look-Up Table (LUT) of arc lengths.
   * @param {number} steps - Number of samples (e.g., 100).
   * @returns {Array} Array of { t, dist } objects.
   */
  getLUT(steps = 100) {
      const lut = [{ t: 0, dist: 0 }];
      let cur = this.p0;
      let totalDist = 0;
      for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const next = this.sample(t);
          totalDist += cur.dist(next);
          lut.push({ t: t, dist: totalDist });
          cur = next;
      }
      return lut;
  }
}

/**
 * @class SvgConverter
 * @description Main class for parsing SVG strings and generating trajectory data.
 */
class SvgConverter {
  /**
   * @constructor
   * @param {Object} options - Configuration options.
   * @param {number} [options.feedRate=300] - Movement speed.
   * @param {number} [options.scale=1.0] - Global scaling factor.
   * @param {number} [options.offsetX=0] - X offset for centering.
   * @param {number} [options.offsetY=0] - Y offset for centering.
   * @param {number} [options.segmentLength=1.0] - Desired length of linear segments (mm).
   * @param {number} [options.stepsPerMM=1.0] - Scaling factor to convert mm to motor steps.
   */
  constructor(options = {}) {
    this.feedRate = options.feedRate || 300;
   this.scale = options.scale || 1.0;
   this.offsetX = options.offsetX || 0;
   this.offsetY = options.offsetY || 0;
    this.flipX = options.flipX || false;
   this.flipY = options.flipY || false;
    this.segmentLength = options.segmentLength || 1.0;
    // Per-axis step rates; stepsPerMM is kept as a fallback for backward compat
    const globalSteps = options.stepsPerMM || 1.0;
    this.stepsPerMM_X = options.stepsPerMM_X || globalSteps;
    this.stepsPerMM_Y = options.stepsPerMM_Y || globalSteps;
    // Defaults mirror the firmware machine config (Urumi-Fw config.py):
    // Z = 1200 steps/mm, A = 120 steps/deg.
    this.stepsPerMM_Z = options.stepsPerMM_Z || 1200.0;
    this.stepsPerDeg_A = options.stepsPerDeg_A || 120.0;

    this.idX = options.idX !== undefined ? options.idX : 3;
    this.idY = options.idY !== undefined ? options.idY : 2;
    this.idZ = options.idZ !== undefined ? options.idZ : 1;
    this.idA = options.idA !== undefined ? options.idA : 4;

    // Z-Axis Config (mm initially, then scaled to steps)
    this.zTravel = options.zTravel !== undefined
        ? options.zTravel
        : (options.zUp !== undefined ? options.zUp : 12);
    this.zUp = this.zTravel;
    this.zDown = options.zDown !== undefined ? options.zDown : 0;
    this.zOffBase = options.zOffBase !== undefined ? options.zOffBase : this.zDown + 1;
    this.zCrease = options.zCrease !== undefined ? options.zCrease : this.zDown + 2;

    // Tangential Knife Config
    this.angleThreshold = options.angleThreshold !== undefined ? options.angleThreshold : 10;
    this.homeAngleA = options.homeAngleA !== undefined ? options.homeAngleA : 90;
    this.decimals = 4;

    // Limits
    this.maxSteps = options.maxSteps !== undefined ? options.maxSteps : 30000;
    this.maxLinearSpeed = options.maxLinearSpeed !== undefined ? options.maxLinearSpeed : 200;
    this.maxRotationalSpeed = options.maxRotationalSpeed !== undefined ? options.maxRotationalSpeed : 720;

    // Limits based on RP2040 capabilities and protocol
    this.maxSteps = Math.min(this.maxSteps, 100000);

    // Bounds
    this.bedW = options.bedW !== undefined ? options.bedW : Infinity;
    this.bedH = options.bedH !== undefined ? options.bedH : Infinity;
  }

  /**
   * @method transform
   * @description Applies scaling, flipping, and offsets to a point.
   * @param {Vector2} p - The point to transform.
   * @returns {Object} The transformed coordinates {x, y}.
   */
  transform(p) {
      let x = (p.x * this.scale);
      if (this.flipX) {
          x = -x;
      }
      x += this.offsetX;
      let y = (p.y * this.scale);
      if (this.flipY) {
          y = -y;
      }
      y += this.offsetY;
      return { x, y };
  }

  normalizeMethod(method = 'thru_cut') {
      const normalized = String(method || 'thru_cut').trim().toLowerCase();
      if (normalized === 'score' || normalized === 'scoring') return 'score';
      if (normalized === 'cut' || normalized === 'through_cut') return 'thru_cut';
      if (normalized === 'off_base' || normalized === 'offbase') return 'score';
      return normalized || 'thru_cut';
  }

  getMethodPriority(method) {
      const normalized = this.normalizeMethod(method);
      if (normalized === 'crease') return 0;
      return 2;
  }

  isCuttingMethod(method) {
      return this.getMethodPriority(method) >= 2;
  }

  getTargetZForMethod(method) {
      const normalized = this.normalizeMethod(method);
      if (normalized === 'crease') return this.zCrease;
      if (normalized === 'score' || normalized === 'off_base') return this.zOffBase;
      return this.zDown;
  }

  distanceSq(a, b) {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return dx * dx + dy * dy;
  }

  cloneCommands(commands) {
      return commands.map(cmd => ({
          type: cmd.type,
          args: Array.isArray(cmd.args) ? cmd.args.slice() : []
      }));
  }

  splitCommandsIntoSubpaths(commands) {
      const subpaths = [];
      let current = [];

      commands.forEach(cmd => {
          if (cmd.type && cmd.type.toUpperCase() === 'M' && current.length > 0) {
              subpaths.push(current);
              current = [];
          }
          current.push(cmd);
      });

      if (current.length > 0) subpaths.push(current);
      return subpaths.filter(subpath => subpath.some(cmd => cmd.type && cmd.type.toUpperCase() === 'M'));
  }

  absolutizeCommands(commands) {
      const absolute = [];
      let cur = new Vector2(0, 0);
      let start = new Vector2(0, 0);

      commands.forEach(cmd => {
          const type = cmd.type.toUpperCase();
          const isRelative = cmd.type === cmd.type.toLowerCase();
          const args = Array.isArray(cmd.args) ? cmd.args.slice() : [];

          const absolutePoint = (idx) => ({
              x: isRelative ? cur.x + args[idx] : args[idx],
              y: isRelative ? cur.y + args[idx + 1] : args[idx + 1]
          });

          if (type === 'M' || type === 'L' || type === 'T') {
              const point = absolutePoint(0);
              cur = new Vector2(point.x, point.y);
              if (type === 'M') start = cur;
              absolute.push({ type, args: [cur.x, cur.y] });
          } else if (type === 'H') {
              cur = new Vector2(isRelative ? cur.x + args[0] : args[0], cur.y);
              absolute.push({ type: 'L', args: [cur.x, cur.y] });
          } else if (type === 'V') {
              cur = new Vector2(cur.x, isRelative ? cur.y + args[0] : args[0]);
              absolute.push({ type: 'L', args: [cur.x, cur.y] });
          } else if (type === 'C') {
              for (let k = 0; k < args.length; k += 2) {
                  if (isRelative) {
                      args[k] += cur.x;
                      args[k + 1] += cur.y;
                  }
              }
              cur = new Vector2(args[4], args[5]);
              absolute.push({ type, args });
          } else if (type === 'S' || type === 'Q') {
              for (let k = 0; k < args.length; k += 2) {
                  if (isRelative) {
                      args[k] += cur.x;
                      args[k + 1] += cur.y;
                  }
              }
              cur = new Vector2(args[args.length - 2], args[args.length - 1]);
              absolute.push({ type, args });
          } else if (type === 'A') {
              if (isRelative) {
                  args[5] += cur.x;
                  args[6] += cur.y;
              }
              cur = new Vector2(args[5], args[6]);
              absolute.push({ type, args });
          } else if (type === 'Z') {
              cur = start;
              absolute.push({ type: 'Z', args: [] });
          }
      });

      return absolute;
  }

  translateCommands(commands, offsetX, offsetY) {
      if (Math.abs(offsetX) < 0.000001 && Math.abs(offsetY) < 0.000001) return commands;

      return commands.map(cmd => {
          const type = cmd.type.toUpperCase();
          const args = cmd.args.slice();
          const translatePair = (idx) => {
              args[idx] += offsetX;
              args[idx + 1] += offsetY;
          };

          if (type === 'M' || type === 'L' || type === 'T') {
              translatePair(0);
          } else if (type === 'C') {
              translatePair(0);
              translatePair(2);
              translatePair(4);
          } else if (type === 'S' || type === 'Q') {
              translatePair(0);
              translatePair(2);
          } else if (type === 'A') {
              translatePair(5);
          }

          return { type, args };
      });
  }

  getAbsolutePolyline(commands) {
      const points = [];
      let cur = new Vector2(0, 0);
      let start = null;
      let closed = false;

      const getPt = (cmd, idx) => {
          const isRelative = cmd.type === cmd.type.toLowerCase();
          return isRelative
              ? new Vector2(cur.x + cmd.args[idx], cur.y + cmd.args[idx + 1])
              : new Vector2(cmd.args[idx], cmd.args[idx + 1]);
      };

      for (const cmd of commands) {
          const type = cmd.type.toUpperCase();
          if (type === 'M') {
              if (points.length > 0) return null;
              cur = getPt(cmd, 0);
              start = cur;
              points.push(cur);
          } else if (type === 'L') {
              cur = getPt(cmd, 0);
              points.push(cur);
          } else if (type === 'H') {
              cur = new Vector2(cmd.type === 'h' ? cur.x + cmd.args[0] : cmd.args[0], cur.y);
              points.push(cur);
          } else if (type === 'V') {
              cur = new Vector2(cur.x, cmd.type === 'v' ? cur.y + cmd.args[0] : cmd.args[0]);
              points.push(cur);
          } else if (type === 'Z') {
              if (start) {
                  cur = start;
                  points.push(cur);
                  closed = true;
              }
          } else {
              return null;
          }
      }

      if (points.length < 2) return null;
      if (this.distanceSq(points[0], points[points.length - 1]) < 0.000001) closed = true;
      return { points, closed };
  }

  reverseCommandsForTravel(commands) {
      const polyline = this.getAbsolutePolyline(commands);
      if (!polyline || polyline.closed) return commands;
      const reversed = polyline.points.slice().reverse();
      return [
          { type: 'M', args: [reversed[0].x, reversed[0].y] },
          ...reversed.slice(1).map(point => ({ type: 'L', args: [point.x, point.y] }))
      ];
  }

  getCommandEndPoint(cmd, cur, start) {
      const type = cmd.type.toUpperCase();
      const isRelative = cmd.type === cmd.type.toLowerCase();
      const getPt = (idx) => isRelative
          ? new Vector2(cur.x + cmd.args[idx], cur.y + cmd.args[idx + 1])
          : new Vector2(cmd.args[idx], cmd.args[idx + 1]);

      if (type === 'M' || type === 'L' || type === 'T') return getPt(0);
      if (type === 'H') return new Vector2(isRelative ? cur.x + cmd.args[0] : cmd.args[0], cur.y);
      if (type === 'V') return new Vector2(cur.x, isRelative ? cur.y + cmd.args[0] : cmd.args[0]);
      if (type === 'C') return getPt(4);
      if (type === 'S' || type === 'Q') return getPt(2);
      if (type === 'A') return getPt(5);
      if (type === 'Z' && start) return start;
      return cur;
  }

  getShapeTravelInfo(commands) {
      let cur = new Vector2(0, 0);
      let start = null;
      let end = null;
      let closed = false;

      for (const cmd of commands) {
          const type = cmd.type.toUpperCase();
          if (type === 'M') {
              cur = this.getCommandEndPoint(cmd, cur, start);
              if (!start) start = cur;
              end = cur;
          } else {
              cur = this.getCommandEndPoint(cmd, cur, start);
              end = cur;
              if (type === 'Z') closed = true;
          }
      }

      if (!start || !end) return null;
      const transformedStart = this.transform(start);
      const transformedEnd = this.transform(end);
      const polyline = this.getAbsolutePolyline(commands);
      const canReverse = !!polyline && !polyline.closed && this.distanceSq(transformedStart, transformedEnd) > 0.000001;

      return {
          start: transformedStart,
          end: transformedEnd,
          closed: closed || this.distanceSq(transformedStart, transformedEnd) < 0.000001,
          canReverse
      };
  }

  optimizeShapeOrder(shapes, state) {
      const prepared = shapes
          .map(shape => ({
              ...shape,
              commands: this.cloneCommands(shape.commands),
              travel: this.getShapeTravelInfo(shape.commands)
          }))
          .filter(shape => shape.travel);

      const ordered = [];
      const priorities = Array.from(new Set(prepared.map(shape => this.getMethodPriority(shape.method))))
          .sort((a, b) => a - b);
      let current = { x: state.machineX, y: state.machineY };

      priorities.forEach(priority => {
          const pending = prepared
              .filter(shape => this.getMethodPriority(shape.method) === priority)
              .sort((a, b) => (a.originalIndex - b.originalIndex) || (a.subIndex - b.subIndex));

          while (pending.length > 0) {
              let bestIndex = 0;
              let bestReverse = false;
              let bestDistance = Infinity;

              pending.forEach((shape, index) => {
                  const startDistance = this.distanceSq(current, shape.travel.start);
                  if (startDistance < bestDistance) {
                      bestDistance = startDistance;
                      bestIndex = index;
                      bestReverse = false;
                  }

                  if (shape.travel.canReverse) {
                      const endDistance = this.distanceSq(current, shape.travel.end);
                      if (endDistance < bestDistance) {
                          bestDistance = endDistance;
                          bestIndex = index;
                          bestReverse = true;
                      }
                  }
              });

              const [selected] = pending.splice(bestIndex, 1);
              if (bestReverse) {
                  selected.commands = this.reverseCommandsForTravel(selected.commands);
                  current = selected.travel.start;
              } else {
                  current = selected.travel.end;
              }
              ordered.push(selected);
          }
      });

      return ordered;
  }

  /**
   * @method convert
   * @description Converts an SVG string into a CSV-formatted trajectory string.
   * @param {string} svgContent - The raw XML string of the SVG file.
   * @returns {string} The generated Trajectory Data (CSV format).
   */
  convert(svgContent) {
    const preamble = [];
    const packets = [];
    const packetMeta = [];

    // First command to enable the motors.
    // WAIT_MS:500 lets the Pico finish its multi-step ENABLE ALL sequence
    // before we send suction or binary commands (prevents "Command queue full").
    preamble.push('enable all 1');
    preamble.push('WAIT_MS:500');

    if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgContent, "image/svg+xml");

        const svgRoot = doc.querySelector('svg');
        let pageW = 0, pageH = 0;
        if (svgRoot) {
            const vb = svgRoot.getAttribute('viewBox');
            const w = svgRoot.getAttribute('width');
            const h = svgRoot.getAttribute('height');

            if (vb) {
                const parts = vb.split(/[\s,]+/).map(parseFloat);
                if (parts.length === 4) {
                    pageW = parts[2];
                    pageH = parts[3];
                }
            } else if (w && h) {
                pageW = parseFloat(w);
                pageH = parseFloat(h);
            }
        }

        const elements = doc.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon');

        const state = {
            isPenDown: false,
            machineX: 0,
            machineY: 0,
            machineZ: this.zUp,
            machineA: this.homeAngleA
        };

        let validElements = [];

        elements.forEach((el, index) => {
            if (el.closest('defs, clipPath, mask, symbol, marker, pattern')) return;

            const style = el.getAttribute('style') || '';
            const display = el.getAttribute('display');
            const visibility = el.getAttribute('visibility');
            if (
                display === 'none' ||
                visibility === 'hidden' ||
                visibility === 'collapse' ||
                style.includes('display:none') ||
                style.includes('display: none') ||
                style.includes('visibility:hidden')
            ) return;

            if (el.tagName.toLowerCase() === 'rect' && pageW > 0 && pageH > 0) {
                const x = parseFloat(el.getAttribute('x') || 0);
                const y = parseFloat(el.getAttribute('y') || 0);
                const w = parseFloat(el.getAttribute('width') || 0);
                const h = parseFloat(el.getAttribute('height') || 0);

                const matchesSize = (Math.abs(w - pageW) < 1.0) && (Math.abs(h - pageH) < 1.0);
                const isAtOrigin = (Math.abs(x) < 1.0) && (Math.abs(y) < 1.0);

                if (matchesSize && isAtOrigin) return;
            }

            validElements.push({ el, originalIndex: index });
        });

        let validShapes = [];
        validElements.forEach(({ el, originalIndex }) => {
            const method = this.normalizeMethod(el.getAttribute('data-method') || 'thru_cut');
            let offsetX = 0;
            let offsetY = 0;

            let parent = el;
            while(parent && parent.tagName !== 'svg') {
                const transform = parent.getAttribute('transform');
                if (transform) {
                    const translateMatch = transform.match(/translate\(\s*([-+]?[\d.]+)\s*[\s, ]\s*([-+]?[\d.]+)\s*\)/);
                    if (translateMatch) {
                        offsetX += parseFloat(translateMatch[1]);
                        offsetY += parseFloat(translateMatch[2]);
                    }
                }
                parent = parent.parentNode;
            }

            const commands = this.translateCommands(this.absolutizeCommands(this.parseElement(el)), offsetX, offsetY);

            this.splitCommandsIntoSubpaths(commands).forEach((subpathCommands, subIndex) => {
                validShapes.push({
                    commands: subpathCommands,
                    method,
                    originalIndex,
                    subIndex,
                    shapeId: `shape_${originalIndex}_${subIndex}`
                });
            });
        });

        validShapes = this.optimizeShapeOrder(validShapes, state);

        const hasCrease = validShapes.some(v => this.normalizeMethod(v.method) === 'crease');
        let beforeCreaseToolChangeInserted = false;
        let afterCreaseToolChangeInserted = false;

        validShapes.forEach(({ commands, method, shapeId }) => {
            const isCrease = this.normalizeMethod(method) === 'crease';
            if (isCrease && !beforeCreaseToolChangeInserted) {
                preamble.push('; --- TOOL CHANGE: INSTALL CREASING TOOL ---');
                preamble.push('PAUSE_FOR_TOOL_CHANGE:Install creasing tool');
                beforeCreaseToolChangeInserted = true;
            }

            if (!isCrease && hasCrease && beforeCreaseToolChangeInserted && !afterCreaseToolChangeInserted) {
                preamble.push('; --- TOOL CHANGE: CREASING COMPLETE ---');
                preamble.push('PAUSE_FOR_TOOL_CHANGE:Switch back to cutting/scoring tool');
                afterCreaseToolChangeInserted = true;
            }

            preamble.push(`; SHAPE_START id=${shapeId} method=${method}`);

            const shapePackets = this.generateTrajectory(commands, state, method, false);
            const packetStart = packets.length;
            packets.push(...shapePackets);
            if (shapePackets.length > 0) {
                packetMeta.push({
                    start: packetStart,
                    end: packets.length - 1,
                    method,
                    shapeId
                });
            }
            preamble.push(`; SHAPE_END`);
        });

        if (hasCrease && beforeCreaseToolChangeInserted && !afterCreaseToolChangeInserted) {
            preamble.push('; --- TOOL CHANGE: CREASING COMPLETE ---');
            preamble.push('PAUSE_FOR_TOOL_CHANGE:Creasing complete; change tool before finishing');
        }

        const finalPackets = [];
        this.emitPoint(finalPackets, state, state.machineX, state.machineY, this.zUp, 0, 0, 0, this.homeAngleA);
        packets.push(...finalPackets);

    } else {
        const state = {
            isPenDown: false,
            machineX: 0,
            machineY: 0,
            machineZ: this.zUp,
            machineA: this.homeAngleA
        };
        const pathRegex = /<path\b[^>]*>/gi;
        let match;
        let validElements = [];
        let index = 0;
        while ((match = pathRegex.exec(svgContent)) !== null) {
          const tag = match[0];
          const dMatch = tag.match(/\bd=[\"']([^\"']+)["']/i);
          if (!dMatch) continue;
          const d = dMatch[1];
          const methodMatch = tag.match(/data-method=[\"']([^\"']+)["']/i);
          const method = this.normalizeMethod(methodMatch ? methodMatch[1] : 'thru_cut');
          validElements.push({ d, method, originalIndex: index++ });
        }

        let validShapes = [];
        validElements.forEach(v => {
            const commands = this.absolutizeCommands(this.parsePathData(v.d));
            this.splitCommandsIntoSubpaths(commands).forEach((subpathCommands, subIndex) => {
                validShapes.push({
                    commands: subpathCommands,
                    method: v.method,
                    originalIndex: v.originalIndex,
                    subIndex,
                    shapeId: `path_${v.originalIndex}_${subIndex}`
                });
            });
        });
        validShapes = this.optimizeShapeOrder(validShapes, state);

        const hasCrease = validShapes.some(v => this.normalizeMethod(v.method) === 'crease');
        let beforeCreaseToolChangeInserted = false;
        let afterCreaseToolChangeInserted = false;

        validShapes.forEach(v => {
            const isCrease = this.normalizeMethod(v.method) === 'crease';
            if (isCrease && !beforeCreaseToolChangeInserted) {
                preamble.push('; --- TOOL CHANGE: INSTALL CREASING TOOL ---');
                preamble.push('PAUSE_FOR_TOOL_CHANGE:Install creasing tool');
                beforeCreaseToolChangeInserted = true;
            }

            if (!isCrease && hasCrease && beforeCreaseToolChangeInserted && !afterCreaseToolChangeInserted) {
                preamble.push('; --- TOOL CHANGE: CREASING COMPLETE ---');
                preamble.push('PAUSE_FOR_TOOL_CHANGE:Switch back to cutting/scoring tool');
                afterCreaseToolChangeInserted = true;
            }

            preamble.push(`; SHAPE_START id=${v.shapeId} method=${v.method}`);
            const shapePackets = this.generateTrajectory(v.commands, state, v.method, false);
            const packetStart = packets.length;
            packets.push(...shapePackets);
            if (shapePackets.length > 0) {
                packetMeta.push({
                    start: packetStart,
                    end: packets.length - 1,
                    method: v.method,
                    shapeId: `path_${v.originalIndex}`
                });
            }
            preamble.push(`; SHAPE_END`);
        });

        if (hasCrease && beforeCreaseToolChangeInserted && !afterCreaseToolChangeInserted) {
            preamble.push('; --- TOOL CHANGE: CREASING COMPLETE ---');
            preamble.push('PAUSE_FOR_TOOL_CHANGE:Creasing complete; change tool before finishing');
        }

        const finalPackets = [];
        this.emitPoint(finalPackets, state, state.machineX, state.machineY, this.zUp, 0, 0, 0, this.homeAngleA);
        packets.push(...finalPackets);
    }

    return { preamble, packets, packetMeta };
  }

  /**
   * @method parseElement
   * @description Parses a DOM element (path, rect, circle) into a standardized list of path commands.
   * @param {Element} el - The DOM element.
   * @returns {Array} List of path commands.
   */
  parseElement(el) {
      const tagName = el.tagName.toLowerCase();
      if (tagName === 'path') {
          return this.parsePathData(el.getAttribute('d') || '');
      } else if (tagName === 'rect') {
          const x = parseFloat(el.getAttribute('x') || 0);
          const y = parseFloat(el.getAttribute('y') || 0);
          const w = parseFloat(el.getAttribute('width') || 0);
          const h = parseFloat(el.getAttribute('height') || 0);
          return [
              { type: 'M', args: [x, y] },
              { type: 'L', args: [x + w, y] },
              { type: 'L', args: [x + w, y + h] },
              { type: 'L', args: [x, y + h] },
              { type: 'L', args: [x, y] }
          ];
      } else if (tagName === 'circle') {
          const cx = parseFloat(el.getAttribute('cx') || 0);
          const cy = parseFloat(el.getAttribute('cy') || 0);
          const r = parseFloat(el.getAttribute('r') || 0);
          const k = 0.552284749831;
          return [
              { type: 'M', args: [cx + r, cy] },
              { type: 'C', args: [cx + r, cy + k*r, cx + k*r, cy + r, cx, cy + r] },
              { type: 'C', args: [cx - k*r, cy + r, cx - r, cy + k*r, cx - r, cy] },
              { type: 'C', args: [cx - r, cy - k*r, cx - k*r, cy - r, cx, cy - r] },
              { type: 'C', args: [cx + k*r, cy - r, cx + r, cy - k*r, cx + r, cy] }
          ];
      } else if (tagName === 'ellipse') {
          const cx = parseFloat(el.getAttribute('cx') || 0);
          const cy = parseFloat(el.getAttribute('cy') || 0);
          const rx = parseFloat(el.getAttribute('rx') || 0);
          const ry = parseFloat(el.getAttribute('ry') || 0);
          const k = 0.552284749831;
          return [
              { type: 'M', args: [cx + rx, cy] },
              { type: 'C', args: [cx + rx, cy + k*ry, cx + k*rx, cy + ry, cx, cy + ry] },
              { type: 'C', args: [cx - k*rx, cy + ry, cx - rx, cy + k*ry, cx - rx, cy] },
              { type: 'C', args: [cx - rx, cy - k*ry, cx - k*rx, cy - ry, cx, cy - ry] },
              { type: 'C', args: [cx + k*rx, cy - ry, cx + rx, cy - k*ry, cx + rx, cy] }
          ];
      } else if (tagName === 'line') {
          const x1 = parseFloat(el.getAttribute('x1') || 0);
          const y1 = parseFloat(el.getAttribute('y1') || 0);
          const x2 = parseFloat(el.getAttribute('x2') || 0);
          const y2 = parseFloat(el.getAttribute('y2') || 0);
          return [
              { type: 'M', args: [x1, y1] },
              { type: 'L', args: [x2, y2] }
          ];
      } else if (tagName === 'polyline' || tagName === 'polygon') {
          const pointsStr = el.getAttribute('points') || '';
          const points = pointsStr.trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
          if (points.length < 2) return [];
          const cmds = [{ type: 'M', args: [points[0], points[1]] }];
          for (let i = 2; i < points.length; i += 2) {
              if (i + 1 < points.length) cmds.push({ type: 'L', args: [points[i], points[i+1]] });
          }
          if (tagName === 'polygon') {
              cmds.push({ type: 'Z', args: [] });
          }
          return cmds;
      }
      return [];
  }

  /**
   * @method parsePathData
   * @description Parses SVG 'd' attribute string into command objects.
   * @param {string} d - The path data string.
   * @returns {Array} Array of command objects {type: 'M', args: [...]}.
   */
  parsePathData(d) {
      const tokens = d.match(/([a-zA-Z])|([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g);
     if (!tokens) return [];
     return this.parseTokens(tokens);
  }

  /**
   * @method parseTokens
   * @description Internal helper to consume tokens and build command list.
   * @param {Array} tokens - List of string tokens.
   * @returns {Array} Commands.
   */
  parseTokens(tokens) {
      const commands = [];
      let i = 0;
      let lastCommand = null;

      const eat = (n) => {
          const args = [];
          for(let k=0; k<n; k++) {
              if (i >= tokens.length) break;
              args.push(parseFloat(tokens[i++]));
          }
          return args;
      };

      while(i < tokens.length) {
          let token = tokens[i];
          let cmdType = token;

          if (/^[a-zA-Z]$/.test(token)) {
              cmdType = token;
              i++;
          } else {
              if (lastCommand) {
                  if (lastCommand.toUpperCase() === 'M') {
                      cmdType = (lastCommand === 'M') ? 'L' : 'l';
                  } else {
                      cmdType = lastCommand;
                  }
              } else {
                  i++; continue;
              }
          }

          lastCommand = cmdType;
          let args = [];
          switch(cmdType.toUpperCase()) {
              case 'M': args = eat(2); break;
              case 'L': args = eat(2); break;
              case 'H': args = eat(1); break;
              case 'V': args = eat(1); break;
              case 'C': args = eat(6); break;
              case 'S': args = eat(4); break;
              case 'Q': args = eat(4); break;
              case 'T': args = eat(2); break;
              case 'A': args = eat(7); break;
              case 'Z': args = []; break;
              default: i++; break;
          }
          commands.push({ type: cmdType, args: args });
      }
      return commands;
  }

  /**
   * @method generateTrajectory
   * @description Converts parsed SVG commands into Trajectory CSV lines.
   * @param {Array} commands - List of parsed commands.
   * @param {Object} state - The machine state.
   * @param {string} method - The shape cutting method (crease, thru_cut, score).
   * @returns {Array} Array of CSV data lines.
   */
  generateTrajectory(commands, state = null, method = 'thru_cut', homeAfterShape = true) {
    const data = [];
    method = this.normalizeMethod(method);
    let cur = new Vector2(0, 0);
    let start = new Vector2(0, 0);
    let lastControl = new Vector2(0, 0);
    let lastCmdType = '';

    const targetZDown = this.getTargetZForMethod(method);

    if (!state) {
        state = {
            isPenDown: false,
            machineX: 0,
            machineY: 0,
            machineZ: this.zUp,
            machineA: this.homeAngleA
        };
    }

    commands.forEach(cmd => {
        const isRelative = (cmd.type === cmd.type.toLowerCase());
        const type = cmd.type.toUpperCase();
        const args = cmd.args;

        const getPt = (idx) => isRelative
            ? new Vector2(cur.x + args[idx], cur.y + args[idx+1])
            : new Vector2(args[idx], args[idx+1]);

        switch (type) {
            case 'M': {
                const p = getPt(0);

                if (state.isPenDown || Math.abs(state.machineZ - this.zUp) > 0.001) {
                    this.emitPoint(data, state, state.machineX, state.machineY, this.zUp, 0, 0, -this.feedRate);
                    state.isPenDown = false;
                }

                // Segment the travel move to avoid large step values (>32000) over long distances
                this.emitLineSubdivided(data, state, p, this.zUp);

                cur = p;
                start = p;
                lastControl = p;
                break;
            }
            case 'L': {
                const p = getPt(0);
                this.emitLineSubdivided(data, state, p, targetZDown);
                cur = p;
                lastControl = p;
                break;
            }
            case 'H': {
                const x = isRelative ? cur.x + args[0] : args[0];
                const p = new Vector2(x, cur.y);
                this.emitLineSubdivided(data, state, p, targetZDown);
                cur = p;
                lastControl = p;
                break;
            }
            case 'V': {
                const y = isRelative ? cur.y + args[0] : args[0];
                const p = new Vector2(cur.x, y);
                this.emitLineSubdivided(data, state, p, targetZDown);
                cur = p;
                lastControl = p;
                break;
            }
            case 'C': {
                const c1 = getPt(0);
                const c2 = getPt(2);
                const p = getPt(4);
                const bezier = new CubicBezier(cur, c1, c2, p);
                this.flattenBezier(data, state, bezier, targetZDown);
                cur = p;
                lastControl = c2;
                break;
            }
            case 'S': {
                let c1 = cur;
                if (lastCmdType === 'C' || lastCmdType === 'S') {
                    c1 = cur.add(cur.sub(lastControl));
                }
                const c2 = getPt(0);
                const p = getPt(2);
                const bezier = new CubicBezier(cur, c1, c2, p);
                this.flattenBezier(data, state, bezier, targetZDown);
                cur = p;
                lastControl = c2;
                break;
            }
            case 'Q': {
                const c1 = getPt(0);
                const p = getPt(2);
                const cp1 = cur.add(c1.sub(cur).mul(2/3));
                const cp2 = p.add(c1.sub(p).mul(2/3));
                const bezier = new CubicBezier(cur, cp1, cp2, p);
                this.flattenBezier(data, state, bezier, targetZDown);
                cur = p;
                lastControl = c1;
                break;
            }
            case 'T': {
                let c1 = cur;
                 if (lastCmdType === 'Q' || lastCmdType === 'T') {
                    c1 = cur.add(cur.sub(lastControl));
                }
                const p = getPt(0);
                 const cp1 = cur.add(c1.sub(cur).mul(2/3));
                const cp2 = p.add(c1.sub(p).mul(2/3));
                const bezier = new CubicBezier(cur, cp1, cp2, p);
                this.flattenBezier(data, state, bezier, targetZDown);
                cur = p;
                lastControl = c1;
                break;
            }
            case 'Z': {
                this.emitLineSubdivided(data, state, start, targetZDown);
                cur = start;
                lastControl = start;
                break;
            }
             case 'A': {
                 const p = getPt(5);
                 this.emitLineSubdivided(data, state, p, targetZDown);
                 cur = p;
                 lastControl = p;
                 break;
             }
        }
        lastCmdType = type;
    });

    if (state.isPenDown || Math.abs(state.machineZ - this.zUp) > 0.001) {
        this.emitPoint(data, state, state.machineX, state.machineY, this.zUp, 0, 0, -this.feedRate);
        state.isPenDown = false;
    }

    if (homeAfterShape) {
        this.emitPoint(data, state, state.machineX, state.machineY, this.zUp, 0, 0, 0, this.homeAngleA);
    }

    return data;
  }

  /**
   * @method emitPoint
   * @description Formats and emits a single row of CSV data, automatically handling Tangential Knife rotations.
   */
  emitPoint(data, state, x, y, z, vx, vy, vz, forcedAngle = null) {
      // Clamp coordinates to cutting bed bounds
      x = Math.max(0, Math.min(this.bedW, x));
      y = Math.max(0, Math.min(this.bedH, y));

      const dx = x - state.machineX;
      const dy = y - state.machineY;
      const dSq = dx * dx + dy * dy;

      const forcedDiff = forcedAngle === null
          ? 0
          : Math.abs((((forcedAngle - state.machineA) + 180) % 360 + 360) % 360 - 180);

      // Skip if effectively identical position and height and no angular correction requested
      if (dSq < 0.000001 && Math.abs(z - state.machineZ) < 0.001 && forcedDiff < 0.001) return;

      let targetA = state.machineA;
      if (forcedAngle !== null) {
          targetA = ((forcedAngle % 360) + 360) % 360;
      } else if (dSq >= 0.000001) {
          targetA = Math.atan2(dy, dx) * 180 / Math.PI;
          targetA = ((targetA % 360) + 360) % 360;
      }

      let diff = targetA - state.machineA;
      diff = ((diff + 180) % 360 + 360) % 360 - 180;

      // Helper to emit a point and track relative Z
      const pushLine = (targetX, targetY, targetZ, targetVx, targetVy, targetVz, targetAngle) => {
          const angleDelta = ((targetAngle - state.machineA + 180) % 360 + 360) % 360 - 180;
          const resolvedTargetAngle = state.machineA + angleDelta;

          // Prevent fractional drift by comparing absolute rounded steps.
          const currentXSteps = Math.round(state.machineX * this.stepsPerMM_X);
          const targetXSteps = Math.round(targetX * this.stepsPerMM_X);
          const relativeXStep = targetXSteps - currentXSteps;

          const currentYSteps = Math.round(state.machineY * this.stepsPerMM_Y);
          const targetYSteps = Math.round(targetY * this.stepsPerMM_Y);
          const relativeYStep = targetYSteps - currentYSteps;

          const currentZSteps = Math.round(state.machineZ * this.stepsPerMM_Z);
          const targetZSteps = Math.round(targetZ * this.stepsPerMM_Z);
          const relativeZStep = currentZSteps - targetZSteps;

          const currentASteps = Math.round(state.machineA * this.stepsPerDeg_A);
          const targetASteps = Math.round(resolvedTargetAngle * this.stepsPerDeg_A);
          const relativeAStep = targetASteps - currentASteps;

          const maxAbsStep = Math.max(
              Math.abs(relativeXStep),
              Math.abs(relativeYStep),
              Math.abs(relativeZStep),
              Math.abs(relativeAStep)
          );

          // Subdivide moves recursively if they exceed firmware limits
          if (maxAbsStep > this.maxSteps) {
              const segments = Math.ceil(maxAbsStep / this.maxSteps);
              const stepX = (targetX - state.machineX) / segments;
              const stepY = (targetY - state.machineY) / segments;
              const stepZ = (targetZ - state.machineZ) / segments;
              const stepA = angleDelta / segments;

              let currX = state.machineX;
              let currY = state.machineY;
              let currZ = state.machineZ;
              let currA = state.machineA;

              for (let i = 1; i <= segments; i++) {
                  currX += stepX;
                  currY += stepY;
                  currZ += stepZ;
                  currA += stepA;
                  pushLine(currX, currY, currZ, targetVx, targetVy, targetVz, currA);
              }
              return;
          }

          let stepVx = Math.abs(Math.round(targetVx * this.stepsPerMM_X));
          let stepVy = Math.abs(Math.round(targetVy * this.stepsPerMM_Y));
          let stepVz = Math.abs(Math.round(targetVz * this.stepsPerMM_Z));

          // If there is no movement at all, don't emit the line (but update state)
          if (relativeXStep === 0 && relativeYStep === 0 && relativeZStep === 0 && relativeAStep === 0) {
              state.machineX = targetX;
              state.machineY = targetY;
              state.machineZ = targetZ;
              state.machineA = ((resolvedTargetAngle % 360) + 360) % 360;
              return;
          }

          // Calculate duration to ensure all nodes arrive simultaneously
          let duration = 0;
          if (stepVx > 0 && relativeXStep !== 0) duration = Math.abs(relativeXStep) / stepVx;
          else if (stepVy > 0 && relativeYStep !== 0) duration = Math.abs(relativeYStep) / stepVy;
          else if (stepVz > 0 && relativeZStep !== 0) duration = Math.abs(relativeZStep) / stepVz;

          let stepVa = 0;
          if (relativeAStep !== 0) {
              if (duration > 0) {
                  stepVa = Math.abs(relativeAStep) / duration;
              } else {
                  // Pure rotation
                  stepVa = this.stepsPerDeg_A * 360; // default 360 deg/sec
                  duration = Math.abs(relativeAStep) / stepVa;
              }
              stepVa = Math.max(1, Math.round(stepVa));
          }

          // Enforce physical maximum speeds per axis to prevent motor stalling.
          if (duration > 0) {
              const maxSpsX = this.maxLinearSpeed * this.stepsPerMM_X;
              const maxSpsY = this.maxLinearSpeed * this.stepsPerMM_Y;
              const maxSpsZ = this.maxLinearSpeed * this.stepsPerMM_Z;
              const maxSpsA = this.maxRotationalSpeed * this.stepsPerDeg_A;

              const currentSpsX = Math.abs(relativeXStep) / duration;
              if (currentSpsX > maxSpsX) duration = Math.abs(relativeXStep) / maxSpsX;

              const currentSpsY = Math.abs(relativeYStep) / duration;
              if (currentSpsY > maxSpsY) duration = Math.abs(relativeYStep) / maxSpsY;

              const currentSpsZ = Math.abs(relativeZStep) / duration;
              if (currentSpsZ > maxSpsZ) duration = Math.abs(relativeZStep) / maxSpsZ;

              const currentSpsA = Math.abs(relativeAStep) / duration;
              if (currentSpsA > maxSpsA) duration = Math.abs(relativeAStep) / maxSpsA;
          }

          let interval = 0;
          if (maxAbsStep > 0) {
              if (duration > 0) {
                  interval = Math.max(1, Math.round((150_000_000 * duration) / maxAbsStep));
              } else {
                  interval = 150_000_000;
              }
              const pkt = packMicrosegment(relativeXStep, relativeYStep, relativeZStep, relativeAStep, interval, 0, 0);
              data.push(pkt);
          }

          state.machineX = targetX;
          state.machineY = targetY;
          state.machineZ = targetZ;
          state.machineA = ((resolvedTargetAngle % 360) + 360) % 360;
      };

      // Handle Plunge/Lift & Tangential knife sharp corners
      if (!state.isPenDown && z !== this.zUp) {
          // Orient (rotation only, no Z move yet)
          pushLine(state.machineX, state.machineY, this.zUp, 0, 0, 0, targetA);
          // Plunge
          pushLine(state.machineX, state.machineY, z, 0, 0, this.feedRate, targetA);
          state.isPenDown = true;
      } else if (state.isPenDown && Math.abs(diff) > this.angleThreshold && z !== this.zUp) {
          // Lift, Orient, Plunge sequence for sharp corners
          pushLine(state.machineX, state.machineY, this.zUp, 0, 0, -this.feedRate, state.machineA);
          pushLine(state.machineX, state.machineY, this.zUp, 0, 0, 0, targetA);
          pushLine(state.machineX, state.machineY, z, 0, 0, this.feedRate, targetA);
      }

      // Purely Z-up moves should keep current orientation
      if (z === this.zUp) {
          state.isPenDown = false;
          targetA = state.machineA;
      }

      // Output scaled steps for the target point
      pushLine(x, y, z, vx, vy, vz, targetA);
  }

  /**
   * @method emitLineSubdivided
   * @description Helper to draw a straight line subdivided into exactly segmentLength intervals.
   */
  emitLineSubdivided(data, state, rawP, targetZ) {
      const startX = state.machineX;
      const startY = state.machineY;
      const zHeight = targetZ !== undefined ? targetZ : this.zDown;

      const p = this.transform(rawP);

      const dx = p.x - startX;
      const dy = p.y - startY;
      const dist = Math.sqrt(dx*dx + dy*dy);

      if (dist < 0.000001) {
          if (Math.abs(zHeight - state.machineZ) > 0.001) {
              this.emitPoint(data, state, p.x, p.y, zHeight, 0, 0, 0);
          }
          return;
      }

      const numSegments = Math.ceil(dist / this.segmentLength);

      // Compute raw velocity from points
      let vx = dx;
      let vy = dy;
      let vz = 0;

      // Normalize and apply target feedrate (mm/sec)
      const mag = Math.sqrt(vx*vx + vy*vy + vz*vz);
      if (mag > 0) {
          vx = (vx / mag) * this.feedRate;
          vy = (vy / mag) * this.feedRate;
          vz = (vz / mag) * this.feedRate;
      }

      for (let i = 1; i <= numSegments; i++) {
          const t = i / numSegments;
          const currX = startX + dx * t;
          const currY = startY + dy * t;

          this.emitPoint(data, state, currX, currY, zHeight, vx, vy, vz);
      }
  }

  /**
   * @method flattenBezier
   * @description Subdivides a Bezier curve into equidistant physical segments.
   */
  flattenBezier(data, state, bezier, targetZ) {
      const steps = 50;
      const lut = bezier.getLUT(steps);
      const totalLength = lut[lut.length - 1].dist;

      const numSegments = Math.ceil(totalLength / this.segmentLength);
      const zHeight = targetZ !== undefined ? targetZ : this.zDown;

      if (numSegments <= 0) {
          this.emitLineSubdivided(data, state, bezier.p3, zHeight);
          return;
      }

      const actualStep = totalLength / numSegments;

      for (let i = 1; i <= numSegments; i++) {
          const targetDist = i * actualStep;

          let tFound = 1.0;
          for (let k = 0; k < lut.length - 1; k++) {
              if (lut[k].dist <= targetDist && lut[k+1].dist >= targetDist) {
                  const dStart = lut[k].dist;
                  const dEnd = lut[k+1].dist;
                  const tStart = lut[k].t;
                  const tEnd = lut[k+1].t;

                  const ratio = (targetDist - dStart) / (dEnd - dStart);
                  tFound = tStart + (tEnd - tStart) * ratio;
                  break;
              }
          }

          const pRaw = bezier.sample(tFound);
          const p = this.transform(pRaw);

          const vRaw = bezier.getVelocity(tFound);
          let vx = this.flipX ? -vRaw.x * this.scale : vRaw.x * this.scale;
          let vy = this.flipY ? -vRaw.y * this.scale : vRaw.y * this.scale;
          let vz = 0;

          // Normalize and apply target feedrate (mm/sec)
          const mag = Math.sqrt(vx*vx + vy*vy + vz*vz);
          if (mag > 0) {
              vx = (vx / mag) * this.feedRate;
              vy = (vy / mag) * this.feedRate;
              vz = (vz / mag) * this.feedRate;
          }

          this.emitPoint(data, state, p.x, p.y, zHeight, vx, vy, vz);
      }
  }
}

export default SvgConverter;
export { Vector2, CubicBezier, SvgConverter };
