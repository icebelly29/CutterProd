import cv2
import numpy as np

img = cv2.imread("C:\\Users\\nikhil\\Coding\\CutterProd-microseg\\rectified_test.png", cv2.IMREAD_GRAYSCALE)
if img is not None:
    # check where the black lines are in the rectified image
    edges = cv2.Canny(img, 50, 150)
    # find lines
    lines = cv2.HoughLinesP(edges, 1, np.pi/180, 100, minLineLength=500, maxLineGap=20)
    if lines is not None:
        for line in lines[:20]:
            x1, y1, x2, y2 = line[0]
            print(f"Line: ({x1}, {y1}) to ({x2}, {y2})")
    else:
        print("No lines found in rectified test image.")
