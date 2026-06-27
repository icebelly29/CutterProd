import cv2
import numpy as np
import json

aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)

def get_marker_svg(marker_id, x, y, size):
    img = cv2.aruco.generateImageMarker(aruco_dict, marker_id, 6) # 4x4 + 2 units of border = 6x6
    rects = []
    # img is 6x6 pixels
    cell_size = size / 6.0
    
    # Add a white background for the whole marker area
    rects.append(f'<rect x="{x}" y="{y}" width="{size}" height="{size}" fill="white"/>')
    
    for i in range(6):
        for j in range(6):
            if img[i, j] == 0: # Black
                px = x + j * cell_size
                py = y + i * cell_size
                rects.append(f'<rect x="{px}" y="{py}" width="{cell_size + 0.1}" height="{cell_size + 0.1}" fill="black"/>')
    return "\n".join(rects)

width = 600
height = 750

# Offset to avoid drawing outside the SVG viewBox
offset_x = 50
offset_y = 50

svg_elements = []

# Add a white background for the entire page to ensure no dark-mode transparency issues
page_width = width + 100
page_height = height + 100
svg_elements.append(f'<rect x="0" y="0" width="{page_width}" height="{page_height}" fill="white"/>')

# Group all visual frame elements so SvgConverter ignores them and doesn't process them into trajectories
svg_elements.append('<g id="urumi-frame" data-ignore="true">')

# Add markers
markers = [
    (12, 0, 0),
    (13, width, 0),
    (14, width, height),
    (15, 0, height)
]
for marker_id, cx, cy in markers:
    # We want the marker centered at (cx, cy)
    marker_size = 50
    svg_elements.append(get_marker_svg(marker_id, cx + offset_x - marker_size/2, cy + offset_y - marker_size/2, marker_size))

# Checkerboard edge markers
step = 50

# Top and Bottom edges
for x in range(int(offset_x * 2), int(width), step):
    index = round((x - (offset_x * 2)) / step)
    fill1 = "white" if index % 2 == 0 else "black"
    fill2 = "black" if index % 2 == 0 else "white"
    
    # Top edge
    svg_elements.append(f'<rect x="{x}" y="{offset_y - marker_size/2}" width="{step}" height="{marker_size/2}" fill="{fill1}"/>')
    svg_elements.append(f'<rect x="{x}" y="{offset_y}" width="{step}" height="{marker_size/2}" fill="{fill2}"/>')
    
    # Bottom edge
    svg_elements.append(f'<rect x="{x}" y="{height + offset_y - marker_size/2}" width="{step}" height="{marker_size/2}" fill="{fill1}"/>')
    svg_elements.append(f'<rect x="{x}" y="{height + offset_y}" width="{step}" height="{marker_size/2}" fill="{fill2}"/>')

# Left and Right edges
for y in range(int(offset_y * 2), int(height), step):
    index = round((y - (offset_y * 2)) / step)
    fill1 = "white" if index % 2 == 0 else "black"
    fill2 = "black" if index % 2 == 0 else "white"
    
    # Left edge
    svg_elements.append(f'<rect x="{offset_x - marker_size/2}" y="{y}" width="{marker_size/2}" height="{step}" fill="{fill1}"/>')
    svg_elements.append(f'<rect x="{offset_x}" y="{y}" width="{marker_size/2}" height="{step}" fill="{fill2}"/>')
    
    # Right edge
    svg_elements.append(f'<rect x="{width + offset_x - marker_size/2}" y="{y}" width="{marker_size/2}" height="{step}" fill="{fill1}"/>')
    svg_elements.append(f'<rect x="{width + offset_x}" y="{y}" width="{marker_size/2}" height="{step}" fill="{fill2}"/>')

# Inner frame border (safe drawing area boundary)
inner_x = offset_x + marker_size / 2
inner_y = offset_y + marker_size / 2
inner_w = width - marker_size
inner_h = height - marker_size
svg_elements.append(f'<rect x="{inner_x}" y="{inner_y}" width="{inner_w}" height="{inner_h}" fill="none" stroke="black" stroke-width="1.5" rx="8" ry="8"/>')

svg_elements.append('</g>')

svg_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<svg width="{page_width}mm" height="{page_height}mm" viewBox="0 0 {page_width} {page_height}" xmlns="http://www.w3.org/2000/svg">
  {"".join(svg_elements)}
</svg>"""

with open("custom.svg", "w") as f:
    f.write(svg_content)

print("Generated custom.svg with simplified clean border style.")
