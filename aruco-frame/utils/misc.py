import cv2
import zlib
import struct
import numpy as np


def solve_affine(xy_array, uv_array):
    if len(xy_array) < 4 or len(uv_array) != len(xy_array):
        raise ValueError(f"Wrong input sizes: should be 4x2 and 4x2")
    n_points = len(uv_array)
    A = np.zeros((2 * n_points, 8))
    b = np.zeros((2 * n_points,))
    for i in range(n_points):
        xy = xy_array[i, :]
        uv = uv_array[i, :]

        A[2 * i, 0:2] = xy
        A[2 * i, 2] = 1
        A[2 * i, 6:8] = -xy * uv[0]

        A[2 * i + 1, 3:5] = xy
        A[2 * i + 1, 5] = 1
        A[2 * i + 1, 6:8] = -xy * uv[1]

        b[2 * i] = uv[0]
        b[2 * i + 1] = uv[1]

    sol = np.ones((9,))
    A_inv = np.linalg.pinv(A) if n_points > 4 else np.linalg.inv(A)
    sol[:8] = A_inv @ b
    return sol.reshape((3, 3))


def writePNGwithdpi(filename, im, dpi=(72, 72)):
    """Save the image as PNG with embedded dpi"""

    # Encode as PNG into memory
    retval, buffer = cv2.imencode(".png", im)
    s = buffer.tobytes()

    # Find start of IDAT chunk
    IDAToffset = s.find(b'IDAT') - 4

    # Create our lovely new pHYs chunk - https://www.w3.org/TR/2003/REC-PNG-20031110/#11pHYs
    pHYs = b'pHYs' + struct.pack('!IIc', int(dpi[0] / 0.0254), int(dpi[1] / 0.0254), b"\x01")
    pHYs = struct.pack('!I', 9) + pHYs + struct.pack('!I', zlib.crc32(pHYs))

    # Open output filename and write...
    # ... stuff preceding IDAT as created by OpenCV
    # ... new pHYs as created by us above
    # ... IDAT onwards as created by OpenCV
    with open(filename, "wb") as out:
        out.write(buffer[0:IDAToffset])
        out.write(pHYs)
        out.write(buffer[IDAToffset:])
