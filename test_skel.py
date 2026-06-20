import cv2
import numpy as np
import os
import sys

# simulate app.py processing
w_px, h_px = 800, 600
blurred = np.zeros((h_px, w_px), dtype=np.uint8)
cv2.circle(blurred, (400, 300), 100, 255, 20) # Draw a thick circle

try:
    binary_mask = cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 61, 5)

    mask_edge_margin = max(10, int(0.05 * min(w_px, h_px)))
    binary_mask[0:mask_edge_margin, :] = 0
    binary_mask[-mask_edge_margin:, :] = 0
    binary_mask[:, 0:mask_edge_margin] = 0
    binary_mask[:, -mask_edge_margin:] = 0

    sys.path.insert(0, os.path.abspath('UrumiCam'))
    from server.skeletonify import thinning, traceSkeleton
    im_skel = (binary_mask > 128).astype(np.uint8)
    im_skel = thinning(im_skel)
    print("Thinning done.")
    polys = traceSkeleton(im_skel, 0, 0, w_px, h_px, 10, 999, [])
    print(f"Skeleton done, {len(polys)} polys found.")

    edge_overlay = np.zeros((h_px, w_px, 4), dtype=np.uint8)
    for poly in polys:
        if len(poly) < 2: continue
        pts = np.array(poly, np.int32).reshape((-1, 1, 2))
        cv2.polylines(edge_overlay, [pts], isClosed=False, color=(255, 100, 180, 80), thickness=4, lineType=cv2.LINE_AA)
        cv2.polylines(edge_overlay, [pts], isClosed=False, color=(255, 100, 180, 255), thickness=2, lineType=cv2.LINE_AA)
    print("Overlay generated.")
except Exception as e:
    import traceback
    traceback.print_exc()
