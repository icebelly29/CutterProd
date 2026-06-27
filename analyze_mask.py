import cv2
import numpy as np

before = cv2.imread("test_binary_mask_before.png", cv2.IMREAD_GRAYSCALE)
after = cv2.imread("test_binary_mask_masked.png", cv2.IMREAD_GRAYSCALE)
paper = cv2.imread("test_paper_mask.png", cv2.IMREAD_GRAYSCALE)

print(f"Before mask white pixels: {np.sum(before > 128)}")
print(f"After mask white pixels: {np.sum(after > 128)}")
print(f"Paper mask area: {np.sum(paper > 128)}")
print(f"Total image area: {before.size}")
