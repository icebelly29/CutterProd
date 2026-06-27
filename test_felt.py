import cv2
import numpy as np

img_path = r"c:\Users\nikhil\Coding\CutterProd-microseg\UrumiCam\static\uploads\rectified_bed.png"
img = cv2.imread(img_path)
h_px, w_px = img.shape[:2]

gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
blurred = cv2.bilateralFilter(gray, 9, 75, 75)

# Direct Otsu thresholding on the grayscale image to find the paper (bright regions)
otsu_bg_thresh, _ = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
# Since the paper is brighter, pixels > otsu_bg_thresh are the paper
_, paper_mask_raw = cv2.threshold(blurred, otsu_bg_thresh, 255, cv2.THRESH_BINARY)

# Clean up the paper mask using morphology
# A closing operation to fill small holes inside the paper (like the dark ink lines)
paper_mask = cv2.morphologyEx(paper_mask_raw, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))

# An opening operation to remove small bright specks on the dark background
paper_mask = cv2.morphologyEx(paper_mask, cv2.MORPH_OPEN, np.ones((15, 15), np.uint8))

cv2.imwrite("test_paper_mask.png", paper_mask)

# Standard stroke detection
blackhat = cv2.morphologyEx(blurred, cv2.MORPH_BLACKHAT, np.ones((15, 15), np.uint8))
otsu_threshold, _ = cv2.threshold(blackhat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
tuned_threshold = max(1, int(round(otsu_threshold * 0.9)))
_, binary_mask = cv2.threshold(blackhat, tuned_threshold, 255, cv2.THRESH_BINARY)

cv2.imwrite("test_binary_mask_before.png", binary_mask)

# Mask the stroke mask with the paper mask
binary_mask = cv2.bitwise_and(binary_mask, paper_mask)

cv2.imwrite("test_binary_mask_masked.png", binary_mask)
print(f"Otsu bg threshold used: {otsu_bg_thresh}")
