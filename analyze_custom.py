import cv2
import numpy as np

img = cv2.imread("C:\\Users\\nikhil\\Coding\\CutterProd-microseg\\frame-design\\test-frames\\custom 2.png")
if img is None:
    print("Could not load image")
else:
    h, w = img.shape[:2]
    print(f"Image shape: {w}x{h}")
    # find ArUco markers to see if they are there
    aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    params = cv2.aruco.DetectorParameters()
    if hasattr(cv2.aruco, 'ArucoDetector'):
        detector = cv2.aruco.ArucoDetector(aruco_dict, params)
        corners, ids, rejected = detector.detectMarkers(img)
    else:
        corners, ids, rejected = cv2.aruco.detectMarkers(img, dictionary=aruco_dict, parameters=params)
    
    print("Detected ArUco IDs:", ids.flatten().tolist() if ids is not None else "None")
    if ids is not None:
        for k in range(len(ids)):
            print(f"ID {ids[k][0]}: {corners[k][0].tolist()}")
