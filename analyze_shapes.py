import cv2
import numpy as np

img = cv2.imread("C:\\Users\\nikhil\\Coding\\CutterProd-microseg\\frame-design\\test-frames\\custom 2.png", cv2.IMREAD_GRAYSCALE)
if img is not None:
    _, thresh = cv2.threshold(img, 128, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    count = 0
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if 20 < w < 200 and 20 < h < 200:
            count += 1
            
    print(f"Number of small square/rect contours found: {count}")
    
    # check for a large continuous boundary line
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if w > 2000 and h > 2000:
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.02 * peri, True)
            print(f"Large contour vertices: {len(approx)}, w={w}, h={h}")
