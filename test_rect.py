import cv2
import json
import sys
import os

sys.path.append("C:\\Users\\nikhil\\Coding\\CutterProd-microseg\\UrumiCam")
from server.method2.aruco_rectifier import ArUcoRectifier

img = cv2.imread("C:\\Users\\nikhil\\Coding\\CutterProd-microseg\\frame-design\\test-frames\\custom 2.png")
rectifier = ArUcoRectifier()
res = rectifier.process_image(img, solve_dist=False)

if res is not None and res["success"]:
    cv2.imwrite("C:\\Users\\nikhil\\Coding\\CutterProd-microseg\\rectified_test.png", res["image"])
    print(f"Success! Saved rectified_test.png. W: {res['physical_width']}, H: {res['physical_height']}, Dots/mm: {res['dots_per_mm']}")
else:
    print("Rectifier failed:", res)
