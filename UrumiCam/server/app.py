"""
============================================================================
                    URUMICAM — FLASK APPLICATION
============================================================================

Flask + Flask-SocketIO server. Serves the web UI and provides real-time
WebSocket communication for scan control and monitoring.

Usage:
    python app.py                  # Production (Pi 4 hardware)
    python app.py --mock           # Development (mock hardware)
    python app.py --mock --port 5000

============================================================================
"""

import os
import sys
import json
import time
import base64
import logging
import argparse
import threading
from pathlib import Path

from flask import Flask, send_from_directory, jsonify, request
from flask_socketio import SocketIO, emit

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.config import Config
from server.uart_comm import UARTComm
from server.gpio_gate import GPIOGate
import cv2
from server.camera import CameraController
from server.method1.roi_detector import ROIDetector
from server.method2.aruco_rectifier import ArUcoRectifier
from server.tile_planner import TilePlanner
from server.quality import FocusChecker
from server.stitcher import MosaicStitcher
from server.scan_io import ScanIO
from server.calibration import CalibrationManager
from server.state_machine import ScanEngine

# ── Logging Setup ──────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("urumicam.app")

# ── Argument Parsing ───────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="UrumiCam Scanner Server")
parser.add_argument("--mock", action="store_true", help="Run with mock hardware")
parser.add_argument("--port", type=int, default=5000, help="Server port")
parser.add_argument("--host", default="0.0.0.0", help="Server host")
args = parser.parse_args()

MOCK_MODE = args.mock

# ── Flask App ──────────────────────────────────────────────────────────────

static_dir = str(Path(__file__).resolve().parent.parent / "static")
app = Flask(__name__, static_folder=static_dir, static_url_path="")
app.config["SECRET_KEY"] = "urumicam-scanner-2026"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "*"
    return response

# ── Initialize Subsystems ─────────────────────────────────────────────────

config = Config()
uart = UARTComm(
    port=config.get("uart_port", "/dev/ttyACM0"),
    baudrate=config.get("uart_baudrate", 115200),
    mock=MOCK_MODE,
)
uart.configure(
    motor_x_addr=config.get("motor_x_addr", 3),
    motor_y_addr=config.get("motor_y_addr", 2),
    steps_per_mm_x=config.get("steps_per_mm_x", 160.0),
    steps_per_mm_y=config.get("steps_per_mm_y", 160.0),
)
gpio = GPIOGate(
    pin=config.get("gpio_quiescence_pin", 17),
    mock=MOCK_MODE,
    dwell_s=config.get("quiescence_dwell_s", 0.4),
)
camera = CameraController(config=config, mock=MOCK_MODE)
roi_detector = ROIDetector(config)
aruco_rectifier = ArUcoRectifier()
tile_planner = TilePlanner(config)
focus_checker = FocusChecker(config)
stitcher = MosaicStitcher(config)
scan_io = ScanIO(base_dir=config.get("scan_output_dir", "scans"))
calibration = CalibrationManager(config, camera, uart, gpio, focus_checker)

engine = ScanEngine(
    config, uart, gpio, camera,
    roi_detector, tile_planner, focus_checker,
    stitcher, scan_io
)

# ── Wire Engine Events to WebSocket ───────────────────────────────────────

def emit_state_change(new_state, old_state):
    socketio.emit("state_change", {
        "state": new_state,
        "previous": old_state,
        "timestamp": time.strftime("%H:%M:%S"),
    })

def emit_tile_update(tile_data):
    socketio.emit("tile_update", tile_data)

def emit_log(message, level="info"):
    socketio.emit("log_message", {
        "message": message,
        "level": level,
        "timestamp": time.strftime("%H:%M:%S"),
    })

def emit_progress(completed, total):
    socketio.emit("scan_progress", {
        "completed": completed,
        "total": total,
    })

def emit_scan_complete(data):
    socketio.emit("scan_complete", data)

def emit_roi_detected(data):
    # Convert contours to serializable format
    roi_payload = {
        "success": data["success"],
        "rois": data["rois"],
        "rois_px": data["rois_px"],
        "method": data["method"],
    }
    socketio.emit("roi_overlay", roi_payload)

def emit_error(error_type, detail):
    socketio.emit("error", {"type": error_type, "detail": detail})

engine.on_state_change = emit_state_change
engine.on_tile_update = emit_tile_update
engine.on_log = emit_log
engine.on_progress = emit_progress
engine.on_scan_complete = emit_scan_complete
engine.on_roi_detected = emit_roi_detected
engine.on_error = emit_error

# ── HTTP Routes ────────────────────────────────────────────────────────────

@app.route("/scans/<path:path>")
def serve_scans(path):
    import os
    scans_base = os.path.abspath(config.get("scan_output_dir", "scans"))
    return send_from_directory(scans_base, path)

@app.route("/")
def index():
    return send_from_directory(static_dir, "index.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(static_dir, path)

@app.route("/api/status")
def api_status():
    return jsonify(engine.get_status())

@app.route("/api/config", methods=["GET"])
def api_get_config():
    return jsonify(config.to_dict())

@app.route("/api/config", methods=["POST"])
def api_set_config():
    updates = request.json
    config.update(updates)
    return jsonify({"status": "ok"})

# ── Method 2 QR & ArUco Bed Upload Pipeline ────────────────────────────────

@app.route("/api/network-info", methods=["GET"])
def api_network_info():
    import socket
    import ipaddress

    def add_candidate(candidates, ip):
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return
        if addr.version != 4 or addr.is_loopback or addr.is_link_local or addr.is_unspecified:
            return
        if ip not in candidates:
            candidates.append(ip)

    candidates = []

    udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        udp_socket.connect(('8.8.8.8', 80))
        add_candidate(candidates, udp_socket.getsockname()[0])
    except Exception:
        pass
    finally:
        udp_socket.close()

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET, socket.SOCK_DGRAM):
            add_candidate(candidates, info[4][0])
    except Exception:
        pass

    if not candidates:
        candidates.append('127.0.0.1')

    def candidate_rank(ip):
        try:
            addr = ipaddress.ip_address(ip)
            if addr.is_private:
                return 0
        except Exception:
            pass
        return 1
    
    candidates = sorted(candidates, key=candidate_rank)
    ip = candidates[0]
    port = request.host.split(":")[1] if ":" in request.host else "5000"
    urls = [f"http://{candidate}:{port}/mobile.html" for candidate in candidates]
    url = urls[0]
    return jsonify({
        "ip": ip,
        "port": port,
        "url": url,
        "urls": urls
    })

@app.route("/api/method2/upload", methods=["POST"])
def api_method2_upload():
    if "image" not in request.files:
        return jsonify({"success": False, "message": "No image file provided"}), 400
        
    file = request.files["image"]
    if file.filename == "":
        return jsonify({"success": False, "message": "Empty file name"}), 400
        
    try:
        # Create static/uploads directory
        uploads_dir = os.path.join(static_dir, "uploads")
        os.makedirs(uploads_dir, exist_ok=True)
        
        # Save raw upload
        raw_path = os.path.join(uploads_dir, "uploaded_bed_raw.jpg")
        file.save(raw_path)
        
        logger.info(f"Saved uploaded raw image to {raw_path}")
        
        # Load image into CV2
        img = cv2.imread(raw_path)
        if img is None:
            return jsonify({"success": False, "message": "Invalid image file format"}), 400
            
        # Run ArUco rectification
        # We explicitly cap target_dpi=150 so it doesn't compute an insanely huge image
        # if the camera was extremely close to the bed. This prevents CV filters from hanging.
        rect_result = aruco_rectifier.process_image(img, solve_dist=True, target_dpi=150)
        
        if not rect_result["success"]:
            return jsonify({
                "success": False, 
                "message": rect_result["message"]
            }), 200
            
        # Save the rectified image
        rectified_path = os.path.join(uploads_dir, "rectified_bed.png")
        cv2.imwrite(rectified_path, rect_result["image"])
        
        # Calculate size in pixels
        h_px, w_px = rect_result["image"].shape[:2]

        # Save bed metadata for direct coordinate mapping on CutterProd
        import json
        meta_path = os.path.join(uploads_dir, "metadata.json")
        with open(meta_path, "w") as mf:
            json.dump({
                "dots_per_mm": float(rect_result["dots_per_mm"]),
                "physical_width": float(rect_result["physical_width"]),
                "physical_height": float(rect_result["physical_height"]),
                "w_px": w_px,
                "h_px": h_px
            }, mf)

        # ── Workpiece Edge & Contour Detection ──
        import numpy as np
        # 1. Grayscale & blur to remove surface/texture noise
        gray = cv2.cvtColor(rect_result["image"], cv2.COLOR_BGR2GRAY)
        blurred = cv2.bilateralFilter(gray, 9, 75, 75)
        
        # 2. Canny Edge Detection
        edges = cv2.Canny(blurred, 30, 90)
        
        # 3. Contour Detection (Use RETR_LIST to find inner and outer shapes)
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        
        # Filter out contours that touch the image borders (likely the ArUco frame itself)
        edge_margin = max(5, int(0.01 * min(w_px, h_px)))
        valid_contours = []
        for c in contours:
            x, y, w, h = cv2.boundingRect(c)
            if x < edge_margin or y < edge_margin or (x + w) > (w_px - edge_margin) or (y + h) > (h_px - edge_margin):
                continue
            valid_contours.append(c)
        contours = valid_contours
        
        # 4a. Generate a dark-stroke mask for skeletonization (ink=white, paper=black).
        # A black-hat transform suppresses the paper grain and broad shading that were
        # causing the adaptive threshold to light up as thousands of tiny specks.
        blackhat = cv2.morphologyEx(
            blurred,
            cv2.MORPH_BLACKHAT,
            np.ones((15, 15), np.uint8)
        )
        otsu_threshold, _ = cv2.threshold(
            blackhat,
            0,
            255,
            cv2.THRESH_BINARY + cv2.THRESH_OTSU
        )
        tuned_threshold = max(1, int(round(otsu_threshold * 0.9)))
        _, binary_mask = cv2.threshold(
            blackhat,
            tuned_threshold,
            255,
            cv2.THRESH_BINARY
        )
        hsv_for_mask = cv2.cvtColor(rect_result["image"], cv2.COLOR_BGR2HSV)
        colored_ink_mask = cv2.inRange(
            hsv_for_mask,
            np.array([0, 38, 0], dtype=np.uint8),
            np.array([179, 255, 248], dtype=np.uint8)
        )
        binary_mask = cv2.bitwise_or(binary_mask, colored_ink_mask)

        # Clear out the border edges (ArUco frame) so it isn't skeletonized.
        # The ArUco markers and frame typically take up 4-5% of the image edge.
        mask_edge_margin = max(10, int(0.05 * min(w_px, h_px)))
        binary_mask[0:mask_edge_margin, :] = 0
        binary_mask[-mask_edge_margin:, :] = 0
        binary_mask[:, 0:mask_edge_margin] = 0
        binary_mask[:, -mask_edge_margin:] = 0

        # Drop tiny connected components before thinning; most of the previous
        # false positives were paper texture islands, not real strokes.
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary_mask, 8)
        component_area_floor = max(24, int(0.000015 * w_px * h_px))
        component_span_floor = max(32, int(0.012 * min(w_px, h_px)))
        filtered_mask = np.zeros_like(binary_mask)
        kept_components = 0
        for label in range(1, num_labels):
            area = stats[label, cv2.CC_STAT_AREA]
            comp_w = stats[label, cv2.CC_STAT_WIDTH]
            comp_h = stats[label, cv2.CC_STAT_HEIGHT]
            if area >= component_area_floor or max(comp_w, comp_h) >= component_span_floor:
                filtered_mask[labels == label] = 255
                kept_components += 1
        binary_mask = cv2.morphologyEx(
            filtered_mask,
            cv2.MORPH_CLOSE,
            np.ones((3, 3), np.uint8),
            iterations=1
        )
        binary_mask[0:mask_edge_margin, :] = 0
        binary_mask[-mask_edge_margin:, :] = 0
        binary_mask[:, 0:mask_edge_margin] = 0
        binary_mask[:, -mask_edge_margin:] = 0
        
        mask_path = os.path.join(uploads_dir, "rectified_mask.png")
        cv2.imwrite(mask_path, binary_mask)
        logger.info(f"Generated binary mask for skeletonizing: {mask_path}")

        # 4b. Perform Skeletonization
        from server.skeletonify import thinning, traceSkeleton

        def polyline_length(poly):
            total = 0.0
            for idx in range(1, len(poly)):
                dx = poly[idx][0] - poly[idx - 1][0]
                dy = poly[idx][1] - poly[idx - 1][1]
                total += float(np.hypot(dx, dy))
            return total

        def point_distance(a, b):
            return float(np.hypot(b[0] - a[0], b[1] - a[1]))

        def dedupe_polyline(poly, min_dist=0.75):
            if len(poly) <= 1:
                return poly[:]
            out = [poly[0]]
            for pt in poly[1:]:
                if point_distance(out[-1], pt) >= min_dist:
                    out.append(pt)
            if len(out) == 1 and len(poly) > 1:
                out.append(poly[-1])
            return out

        def point_to_segment_distance(point, start, end):
            dx = end[0] - start[0]
            dy = end[1] - start[1]
            if dx == 0 and dy == 0:
                return point_distance(point, start)
            t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / float(dx * dx + dy * dy)
            t = max(0.0, min(1.0, t))
            proj = [start[0] + t * dx, start[1] + t * dy]
            return point_distance(point, proj)

        def simplify_rdp(points, epsilon):
            if len(points) <= 2:
                return points[:]
            max_dist = 0.0
            max_idx = -1
            for idx in range(1, len(points) - 1):
                dist = point_to_segment_distance(points[idx], points[0], points[-1])
                if dist > max_dist:
                    max_dist = dist
                    max_idx = idx
            if max_dist <= epsilon or max_idx == -1:
                return [points[0], points[-1]]
            left = simplify_rdp(points[:max_idx + 1], epsilon)
            right = simplify_rdp(points[max_idx:], epsilon)
            return left[:-1] + right

        def polyline_bounds(poly):
            xs = [pt[0] for pt in poly]
            ys = [pt[1] for pt in poly]
            return min(xs), min(ys), max(xs), max(ys)

        def is_closed_polyline(poly):
            if len(poly) < 5:
                return False
            min_x, min_y, max_x, max_y = polyline_bounds(poly)
            diag = float(np.hypot(max_x - min_x, max_y - min_y))
            return point_distance(poly[0], poly[-1]) <= max(3.0, diag * 0.08)

        def simplify_trace_polyline(poly):
            points = dedupe_polyline(poly)
            if len(points) <= 2:
                return points

            min_x, min_y, max_x, max_y = polyline_bounds(points)
            diag = float(np.hypot(max_x - min_x, max_y - min_y))
            length = polyline_length(points)
            if length <= 0:
                return points

            if is_closed_polyline(points):
                epsilon = max(0.45, min(2.2, diag * 0.006))
                contour = np.array(points, dtype=np.float32).reshape((-1, 1, 2))
                approx = cv2.approxPolyDP(contour, epsilon, True)
                simplified = [
                    [int(round(pt[0][0])), int(round(pt[0][1]))]
                    for pt in approx
                ]
                if len(simplified) < 8 and len(points) >= 8:
                    simplified = points
                elif simplified and point_distance(simplified[0], simplified[-1]) > 0:
                    simplified.append(simplified[0])
                return simplified

            direct = point_distance(points[0], points[-1])
            straightness = direct / length if length else 1.0
            epsilon = max(0.5, min(5.0, diag * 0.008 + len(points) * 0.0015))
            simplified = simplify_rdp(points, epsilon)

            # Curvy open strokes, like smiles or letters, should not collapse to a single angle.
            if straightness < 0.88 and len(simplified) < 4 and len(points) >= 8:
                simplified = simplify_rdp(points, max(0.35, epsilon * 0.45))
                if len(simplified) < 4:
                    return points
            return simplified

        def ellipse_polyline_from_bbox(x, y, comp_w, comp_h):
            cx = x + (comp_w - 1) / 2.0
            cy = y + (comp_h - 1) / 2.0
            rx = max(1.0, comp_w / 2.0 - 1.0)
            ry = max(1.0, comp_h / 2.0 - 1.0)
            point_count = int(max(12, min(36, round((rx + ry) * 1.5))))
            points = []
            for idx in range(point_count):
                theta = (2.0 * np.pi * idx) / point_count
                points.append([
                    int(round(cx + np.cos(theta) * rx)),
                    int(round(cy + np.sin(theta) * ry)),
                ])
            points.append(points[0])
            return points

        method_styles = {
            "thru_cut": {
                "svg": "#3b82f6",
                "overlay_outer": (246, 130, 59, 90),
                "overlay_inner": (246, 130, 59, 255),
            },
            "score": {
                "svg": "#ef4444",
                "overlay_outer": (68, 68, 239, 90),
                "overlay_inner": (68, 68, 239, 255),
            },
            "crease": {
                "svg": "#22c55e",
                "overlay_outer": (94, 197, 34, 90),
                "overlay_inner": (94, 197, 34, 255),
            },
        }

        hsv_rectified = cv2.cvtColor(rect_result["image"], cv2.COLOR_BGR2HSV)

        def classify_polyline_method(poly):
            votes = {"red": 0, "green": 0, "blue": 0, "neutral": 0}
            sample_count = min(28, len(poly))
            for sample_idx in range(sample_count):
                poly_idx = int(round(sample_idx * (len(poly) - 1) / max(1, sample_count - 1)))
                px, py = poly[poly_idx]
                best = None

                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        sx = min(max(int(round(px + dx)), 0), w_px - 1)
                        sy = min(max(int(round(py + dy)), 0), h_px - 1)
                        h_val, s_val, v_val = hsv_rectified[sy, sx]
                        # Prefer saturated ink pixels near the skeleton over paper/noise.
                        score = int(s_val) * 2 + max(0, 245 - int(v_val))
                        if best is None or score > best[0]:
                            best = (score, int(h_val), int(s_val), int(v_val))

                if best is None:
                    continue

                _, hue, sat, val = best
                if sat < 35 or val > 250:
                    votes["neutral"] += 1
                elif hue < 10 or hue >= 165:
                    votes["red"] += 1
                elif 35 <= hue <= 88:
                    votes["green"] += 1
                elif 90 <= hue <= 140:
                    votes["blue"] += 1
                else:
                    votes["neutral"] += 1

            dominant = max(votes, key=votes.get)
            if dominant == "red":
                return "score"
            if dominant == "green":
                return "crease"
            return "thru_cut"

        skeleton_mask = binary_mask.copy()
        loop_overrides = []
        num_loop_labels, loop_labels, loop_stats, _ = cv2.connectedComponentsWithStats(binary_mask, 8)
        compact_span_cap = max(24, int(0.08 * min(w_px, h_px)))

        for label in range(1, num_loop_labels):
            x = loop_stats[label, cv2.CC_STAT_LEFT]
            y = loop_stats[label, cv2.CC_STAT_TOP]
            comp_w = loop_stats[label, cv2.CC_STAT_WIDTH]
            comp_h = loop_stats[label, cv2.CC_STAT_HEIGHT]
            area = loop_stats[label, cv2.CC_STAT_AREA]
            span = max(comp_w, comp_h)
            if span > compact_span_cap or comp_w < 5 or comp_h < 5:
                continue

            aspect = comp_w / float(comp_h)
            density = area / float(max(1, comp_w * comp_h))
            comp_mask = (loop_labels[y:y + comp_h, x:x + comp_w] == label).astype(np.uint8)
            comp_contours, _ = cv2.findContours(comp_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not comp_contours:
                continue
            contour = max(comp_contours, key=cv2.contourArea)
            perimeter = cv2.arcLength(contour, True)
            contour_area = cv2.contourArea(contour)
            circularity = 0.0 if perimeter <= 0 else (4.0 * np.pi * contour_area) / (perimeter * perimeter)

            if 0.55 <= aspect <= 1.85 and 0.28 <= density <= 0.90 and circularity >= 0.32:
                ellipse_poly = ellipse_polyline_from_bbox(x, y, comp_w, comp_h)
                loop_overrides.append({
                    "points": ellipse_poly,
                    "method": classify_polyline_method(ellipse_poly),
                })
                skeleton_mask[loop_labels == label] = 0

        # Optimization: Downscale for skeletonization to avoid hanging on large mobile photos
        max_skel_dim = 1600
        scale = min(1.0, max_skel_dim / max(w_px, h_px))

        t_skel_start = time.perf_counter()
        if scale < 1.0:
            new_w, new_h = int(w_px * scale), int(h_px * scale)
            work_mask = cv2.resize(skeleton_mask, (new_w, new_h), interpolation=cv2.INTER_NEAREST)
        else:
            new_w, new_h = w_px, h_px
            work_mask = skeleton_mask

        im_skel = thinning((work_mask > 128).astype(np.uint8))
        t_after_thinning = time.perf_counter()

        # traceSkeleton becomes very slow when it recursively scans an entire sparse
        # canvas, so trace each kept skeleton component inside its own bounding box.
        num_skel_labels, _, skel_stats, _ = cv2.connectedComponentsWithStats(
            im_skel.astype(np.uint8),
            8
        )
        trace_pad = 2
        min_trace_area = 8
        min_trace_span = 18
        min_trace_length = 18.0
        polys = loop_overrides[:]

        for label in range(1, num_skel_labels):
            x = skel_stats[label, cv2.CC_STAT_LEFT]
            y = skel_stats[label, cv2.CC_STAT_TOP]
            comp_w = skel_stats[label, cv2.CC_STAT_WIDTH]
            comp_h = skel_stats[label, cv2.CC_STAT_HEIGHT]
            area = skel_stats[label, cv2.CC_STAT_AREA]
            if area < min_trace_area and max(comp_w, comp_h) < min_trace_span:
                continue

            x0 = max(0, x - trace_pad)
            y0 = max(0, y - trace_pad)
            x1 = min(new_w, x + comp_w + trace_pad)
            y1 = min(new_h, y + comp_h + trace_pad)
            roi = im_skel[y0:y1, x0:x1]

            for poly in traceSkeleton(roi, 0, 0, roi.shape[1], roi.shape[0], 2, 999, []):
                if len(poly) < 2:
                    continue
                shifted_poly = [[int(pt[0] + x0), int(pt[1] + y0)] for pt in poly]
                if polyline_length(shifted_poly) < min_trace_length:
                    continue
                if scale < 1.0:
                    shifted_poly = [
                        [int(round(pt[0] / scale)), int(round(pt[1] / scale))]
                        for pt in shifted_poly
                    ]
                method = classify_polyline_method(shifted_poly)
                shifted_poly = simplify_trace_polyline(shifted_poly)
                if len(shifted_poly) < 2 or polyline_length(shifted_poly) < min_trace_length:
                    continue
                polys.append({
                    "points": shifted_poly,
                    "method": method,
                })

        t_after_trace = time.perf_counter()

        logger.info(
            "Skeleton pipeline: %d raw mask components -> %d kept, scale=%.3f, "
            "thinning=%.3fs, trace=%.3fs, polylines=%d",
            max(0, num_labels - 1),
            kept_components,
            scale,
            t_after_thinning - t_skel_start,
            t_after_trace - t_after_thinning,
            len(polys),
        )

        # 4. Generate transparent overlay with color-coded edge lines (alpha channel)
        edge_overlay = np.zeros((h_px, w_px, 4), dtype=np.uint8)
        
        # Draw skeleton polylines
        for traced in polys:
            poly = traced["points"]
            if len(poly) < 2: continue
            pts = np.array(poly, np.int32).reshape((-1, 1, 2))
            style = method_styles.get(traced["method"], method_styles["thru_cut"])
            cv2.polylines(edge_overlay, [pts], isClosed=False, color=style["overlay_inner"], thickness=1, lineType=cv2.LINE_AA)

        edges_path = os.path.join(uploads_dir, "rectified_edges.png")
        cv2.imwrite(edges_path, edge_overlay)
        logger.info(f"Generated neon-edge detection overlay: {edges_path}")

        # 4c. Generate SVG from skeleton polylines
        svg_path = os.path.join(uploads_dir, "rectified_edges.svg")
        with open(svg_path, "w") as f:
            f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w_px} {h_px}" width="{w_px}px" height="{h_px}px">\n')
            
            # Embed metadata for CutterProd absolute scaling
            meta_json = json.dumps({
                "dots_per_mm": float(rect_result["dots_per_mm"]),
                "physical_width": float(rect_result["physical_width"]),
                "physical_height": float(rect_result["physical_height"])
            })
            f.write(f"  <meta name=\"urumi-scanner\" content='{meta_json}' />\n")
            
            f.write('  <style>path { fill: none; stroke-width: 1px; vector-effect: non-scaling-stroke; stroke-linejoin: round; stroke-linecap: round; }</style>\n')
            for traced in polys:
                poly = traced["points"]
                if len(poly) < 2:
                    continue
                d = []
                for i, pt in enumerate(poly):
                    x, y = pt
                    prefix = "M" if i == 0 else "L"
                    d.append(f"{prefix} {x} {y}")
                method = traced["method"]
                stroke = method_styles.get(method, method_styles["thru_cut"])["svg"]
                f.write(f'  <path d="{" ".join(d)}" stroke="{stroke}" data-method="{method}" />\n')
            f.write('</svg>')
        logger.info(f"Generated vector SVG edges: {svg_path}")

        # 5. Workpiece Bounding Box (Auto-ROI) Detection
        min_contour_area = 1000  # square pixels to ignore specks
        workpieces = [c for c in contours if cv2.contourArea(c) > min_contour_area]
        
        detected_roi = None
        if workpieces:
            # Largest contour represents primary workpiece
            largest = max(workpieces, key=cv2.contourArea)
            rx, ry, rw, rh = cv2.boundingRect(largest)
            
            # Apply padding margin (e.g. 5mm) to the ROI bounding box
            dots_per_mm = rect_result["dots_per_mm"]
            margin_px = int(5 * dots_per_mm)
            
            rx_mm = max(0.0, float(rx - margin_px) / dots_per_mm)
            ry_mm = max(0.0, float(ry - margin_px) / dots_per_mm)
            rw_mm = min(float(rect_result["physical_width"]) - rx_mm, float(rw + 2 * margin_px) / dots_per_mm)
            rh_mm = min(float(rect_result["physical_height"]) - ry_mm, float(rh + 2 * margin_px) / dots_per_mm)
            
            detected_roi = {
                "x": rx_mm,
                "y": ry_mm,
                "w": rw_mm,
                "h": rh_mm
            }
            logger.info(f"Auto-ROI detected workpiece bounding box: {detected_roi} mm")

        payload = {
            "success": True,
            "image_url": f"/uploads/rectified_bed.png?t={int(time.time())}",
            "edges_image_url": f"/uploads/rectified_edges.png?t={int(time.time())}",
            "mask_image_url": f"/uploads/rectified_mask.png?t={int(time.time())}",
            "edges_svg_url": f"/uploads/rectified_edges.svg?t={int(time.time())}",
            "frame_name": rect_result["frame_name"],
            "physical_width": rect_result["physical_width"],
            "physical_height": rect_result["physical_height"],
            "dots_per_mm": rect_result["dots_per_mm"],
            "dpi": rect_result["dpi"],
            "error_mm": float(rect_result["error_mm"]),
            "width_px": w_px,
            "height_px": h_px,
            "detected_roi": detected_roi
        }
        
        # Notify all connected clients via WS that a new rectified bed is uploaded
        socketio.emit("bed_rectified", payload)
        
        return jsonify(payload)
        
    except Exception as e:
        logger.exception("Error in mobile photo upload / rectification")
        return jsonify({"success": False, "message": f"Server processing error: {str(e)}"}), 500

# ── WebSocket Events ───────────────────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    logger.info("[WS] Client connected")
    emit("state_change", {
        "state": engine.state.value,
        "previous": None,
        "timestamp": time.strftime("%H:%M:%S"),
    })
    emit("log_message", {
        "message": f"Connected to UrumiCam {'(MOCK)' if MOCK_MODE else ''}",
        "level": "success",
        "timestamp": time.strftime("%H:%M:%S"),
    })

@socketio.on("scan_start")
def on_scan_start(data):
    folder_name = data.get("folder_name", time.strftime("scan_%Y%m%d_%H%M%S"))
    roi_box = data.get("roi_box")
    logger.info(f"[WS] Scan start: {folder_name} with ROI {roi_box}")
    engine.start_scan(folder_name, roi_box)

@socketio.on("scan_abort")
def on_scan_abort(data=None):
    logger.info("[WS] Scan abort")
    engine.abort_scan()

@socketio.on("roi_confirm")
def on_roi_confirm(data):
    logger.info("[WS] ROI confirmed")
    engine.confirm_roi(data)

@socketio.on("roi_rescan")
def on_roi_rescan(data=None):
    logger.info("[WS] ROI rescan requested")
    engine.rescan_roi()

@socketio.on("retry_failed")
def on_retry_failed(data=None):
    logger.info("[WS] Retry failed tiles")
    engine.retry_failed_tiles()

@socketio.on("scan_reset")
def on_scan_reset(data=None):
    logger.info("[WS] Scan reset")
    engine.reset()

@socketio.on("jog")
def on_jog(data):
    """Jog the gantry by a step in a given direction."""
    if engine.state.value != "idle":
        emit("log_message", {"message": "Cannot jog during scan",
                             "level": "warning",
                             "timestamp": time.strftime("%H:%M:%S")})
        return

    direction = data.get("dir", "")
    step_mm   = float(data.get("step_mm", 1.0))
    sps       = int(config.get("move_sps", 800))
    spmx      = config.get("steps_per_mm_x", 160.0)
    spmy      = config.get("steps_per_mm_y", 160.0)

    dx_steps = 0
    dy_steps = 0
    if   direction == "x+": dx_steps =  int(step_mm * spmx)
    elif direction == "x-": dx_steps = -int(step_mm * spmx)
    elif direction == "y+": dy_steps =  int(step_mm * spmy)
    elif direction == "y-": dy_steps = -int(step_mm * spmy)
    else:
        emit("log_message", {"message": f"Unknown jog direction: {direction}",
                             "level": "error",
                             "timestamp": time.strftime("%H:%M:%S")})
        return

    logger.info(f"[WS] Jog {direction} {step_mm}mm ({dx_steps},{dy_steps} steps)")

    def _on_jog_done(pos_mm):
        socketio.emit("position_update", {
            "x_mm": pos_mm["x_mm"],
            "y_mm": pos_mm["y_mm"],
        })

    uart.send_jog(dx_steps, dy_steps, sps=sps, on_complete=_on_jog_done)

@socketio.on("reset_position")
def on_reset_position(data=None):
    """Reset the tracked position to (0, 0) without moving."""
    logger.info("[WS] Position reset to (0,0)")
    uart.reset_position()
    socketio.emit("position_update", {"x_mm": 0.0, "y_mm": 0.0})

@socketio.on("send_to_cutter")
def on_send_to_cutter(data=None):
    """Reads the latest rectified SVG edges and broadcasts it directly to CutterProd clients."""
    logger.info("[WS] Pushing SVG contour directly to CutterProd clients")
    try:
        svg_path = os.path.join(static_dir, "uploads", "rectified_edges.svg")
        if os.path.exists(svg_path):
            with open(svg_path, "r", encoding="utf-8") as f:
                svg_text = f.read()
            socketio.emit("import_svg_in_cutter", {"svg_text": svg_text})
            logger.info(f"[WS] Broadcasted SVG content ({len(svg_text)} chars)")
        else:
            logger.error(f"[WS] SVG file not found at {svg_path}")
            socketio.emit("import_svg_in_cutter", {"error": "SVG file not found on server"})
    except Exception as e:
        logger.exception("[WS] Failed to read or push SVG")
        socketio.emit("import_svg_in_cutter", {"error": str(e)})

@socketio.on("config_update")
def on_config_update(data):
    logger.info(f"[WS] Config update: {list(data.keys())}")
    config.update(data)
    emit("log_message", {
        "message": "Configuration updated",
        "level": "success",
        "timestamp": time.strftime("%H:%M:%S"),
    })

@socketio.on("calibrate")
def on_calibrate(data):
    cal_type = data.get("type", "")
    logger.info(f"[WS] Calibration: {cal_type}")

    def progress(msg):
        emit_log(f"[CAL] {msg}", "info")

    if cal_type == "pixels_per_step":
        result = calibration.calibrate_pixels_per_step(
            step_count=data.get("step_count", 1000),
            callback=progress
        )
    elif cal_type == "tile_fov":
        result = calibration.calibrate_tile_fov(
            known_width_mm=data.get("width_mm", 10),
            known_height_mm=data.get("height_mm", 7.5),
            callback=progress
        )
    elif cal_type == "focus_baseline":
        result = calibration.calibrate_focus_baseline(callback=progress)
    elif cal_type == "quiescence":
        result = calibration.calibrate_quiescence(callback=progress)
    elif cal_type == "aruco_dpi":
        result = calibration.calibrate_aruco_dpi(
            marker_id=data.get("marker_id", 0),
            marker_size_mm=data.get("marker_size_mm", 20.0),
            callback=progress
        )
    else:
        result = {"error": f"Unknown calibration type: {cal_type}"}

    emit("calibration_result", result)

# ── Camera Preview Stream ─────────────────────────────────────────────────

@socketio.on("start_preview")
def on_start_preview(data=None):
    camera.start_preview()
    # Start emitting frames
    def stream_frames():
        while camera._preview_running:
            frame = camera.get_preview_frame()
            if frame:
                b64 = base64.b64encode(frame).decode("ascii")
                socketio.emit("camera_frame", {"data": b64})
            socketio.sleep(0.066)  # ~15 FPS
    socketio.start_background_task(stream_frames)

@socketio.on("stop_preview")
def on_stop_preview(data=None):
    camera.stop_preview()

# ── Mock Mode Helpers ──────────────────────────────────────────────────────

if MOCK_MODE:
    def mock_scan_simulation():
        """Simulate Pico 2 responses in mock mode."""
        original_send_move = uart.send_move_to

        def mock_send_move(x, y):
            original_send_move(x, y)
            # Simulate arrival after a delay
            def delayed_arrival():
                time.sleep(0.3)  # Simulate motion time
                uart.mock_inject(f"ACK_ARRIVED {int(x)} {int(y)}")
                time.sleep(0.1)
                gpio.mock_set_quiescent(True)
                time.sleep(0.5)
                gpio.mock_set_quiescent(False)
            threading.Thread(target=delayed_arrival, daemon=True).start()

        uart.send_move_to = mock_send_move

    mock_scan_simulation()

# ── Startup ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mode = "MOCK" if MOCK_MODE else "PRODUCTION"
    logger.info(f"╔════════════════════════════════════════╗")
    logger.info(f"║   UrumiCam Scanner Server ({mode:10s}) ║")
    logger.info(f"╠════════════════════════════════════════╣")
    logger.info(f"║   Port: {args.port:<31}║")
    logger.info(f"║   Host: {args.host:<31}║")
    logger.info(f"╚════════════════════════════════════════╝")

    # Connect UART
    uart.connect()

    # Start Flask-SocketIO
    socketio.run(app, host=args.host, port=args.port, debug=False, allow_unsafe_werkzeug=True)
