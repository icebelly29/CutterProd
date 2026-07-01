/**
 * @class Vector2
 * @description Represents a 2D vector with basic arithmetic operations.
 */
export class Vector2 {
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
export class CubicBezier {
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
