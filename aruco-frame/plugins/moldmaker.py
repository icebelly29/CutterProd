import cv2
import numpy as np
import matplotlib.pyplot as plt
import math
import plyfile
import re
import argparse


def parse_arguments():
    usage_text = (
        "Usage:  python aruco-frame.py [options]"
    )
    parser = argparse.ArgumentParser(description=usage_text)
    parser.add_argument("-i", "--input", type=str,
                        help="Input filename.")
    parser.add_argument("-o", "--output", type=str, default="",
                        help="Output filename (default: <filename_in>.ply).")
    parser.add_argument("-d", "--dpi", type=int, default=-1,
                        help="Manual output DPI (default: auto).")
    parser.add_argument("-s", "--show", action="store_true",
                        help="Show debug image.")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Verbose mode (default: false).")
    return parser.parse_known_args()


def write_ply(filename, xyz, triangles, ascii=False):
    n_points, _ = xyz.shape
    n_faces, _ = triangles.shape

    vert_data = np.zeros((n_points,), dtype=[
        ("x", "float32"),
        ("y", "float32"),
        ("z", "float32")])
    vert_data["x"][:] = xyz[:, 0]
    vert_data["y"][:] = xyz[:, 1]
    vert_data["z"][:] = xyz[:, 2]

    face_data = np.zeros((n_faces,), dtype=[
        ('vertex_indices', 'i4', (3,)),
    ])

    face_data['vertex_indices'] = triangles

    el1 = plyfile.PlyElement.describe(vert_data, "vertex")
    el2 = plyfile.PlyElement.describe(face_data, "face")
    dat = plyfile.PlyData([el1, el2], text=ascii)
    dat.write(filename)


def write_svg(filename, pts_mm):
    with open(filename, "w") as f:
        f.write(
            '<svg width="300mm" height="300mm" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg"><polyline points="')
        for pt in pts_mm:
            x, y = pt
            f.write(f"{x:.3f},{300 - y:.3f} ")
        f.write('" fill="none" stroke="black" /></svg>')


def imshow(img, h_view=700, win_name="debug", waitkey=True):
    dtype = img.dtype
    if dtype == bool:
        img = img.astype(np.uint8) * 255
    h, w = img.shape[:2]
    w_view = int(h_view * w / h)
    cv2.imshow(win_name, cv2.resize(img, (w_view, h_view), interpolation=cv2.INTER_AREA))
    if waitkey:
        cv2.waitKey(0)


def find_axis(img_thresh):
    img_bin = img_thresh > 0
    # img_thresh = img[:, :, 0] < 255

    # imshow(img_thresh)

    y = np.sum(img_thresh / 255, axis=1)

    def find_first(x_bin):
        return np.argmax(x_bin)

    def find_last(x_bin):
        length = len(x_bin)
        return (length - 1) - np.argmax(x_bin[::-1])

    n_min = 2
    i1 = find_first(y > n_min)
    i2 = find_last(y > n_min)

    j1 = (find_first(img_bin[i1, :]) + find_last(img_bin[i1, :])) // 2
    j2 = (find_first(img_bin[i2, :]) + find_last(img_bin[i2, :])) // 2

    pt1 = np.array((j1, i1), dtype=np.int32)
    pt2 = np.array((j2, i2), dtype=np.int32)

    return pt1, pt2


def mm_to_px(x, dpi):
    return x * dpi / 25.4


def px_to_mm(x, dpi):
    return x / (dpi / 25.4)


def threshold(img_gray, dpi, min_stroke_mm=15.0):
    img_thresh = cv2.adaptiveThreshold(img_gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 17, 5)
    # img_thresh = cv2.adaptiveThreshold(img_gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 9)

    if min_stroke_mm > 0.0:
        cts, hierarchy = cv2.findContours(img_thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)

        cts_noise = []
        for ct in cts:
            ct_len = np.sum(np.linalg.norm(ct[1:, 0, :] - ct[:-1, 0, :], axis=1))
            ct_len_mm = px_to_mm(ct_len, dpi)
            if ct_len_mm < min_stroke_mm:
                cts_noise.append(ct)

        cv2.drawContours(img_thresh, cts_noise, -1, (0, 0, 0), thickness=cv2.FILLED)

    return img_thresh


def normalize_and_filter_section(section, k_filt=5, n_samp=256):
    section -= np.mean(section, axis=0, keepdims=True)

    n = len(section)

    section_ext = np.zeros((n + 1, 2))
    section_ext[:-1, 0] = section[:, 0]
    section_ext[:-1, 1] = section[:, 1]
    section_ext[-1, :] = section_ext[0, :]

    k_half = (k_filt - 1) // 2

    # filter
    section_ext[:, 0] = np.convolve(np.pad(section_ext[:, 0], [k_half, k_half], "wrap"), np.ones((k_filt,)) / k_filt,
                                    "valid")
    section_ext[:, 1] = np.convolve(np.pad(section_ext[:, 1], [k_half, k_half], "wrap"), np.ones((k_filt,)) / k_filt,
                                    "valid")

    r = np.linalg.norm(section, axis=1)
    section_ext /= np.max(r)

    length = np.zeros((n + 1,))
    deltas = section_ext[1:] - section_ext[:-1]
    length[1:] = np.cumsum(np.linalg.norm(deltas, axis=1))

    length_paced = np.linspace(0, length[-1], n_samp + 1)

    section_new = np.zeros((n_samp, 2))

    section_new[:, 0] = np.interp(length_paced, length, section_ext[:, 0])[:-1]
    section_new[:, 1] = np.interp(length_paced, length, section_ext[:, 1])[:-1]

    return section_new


def hermite(n):
    t = np.linspace(0, 1, n)
    return 2 * (t ** 3) - 3 * (t ** 2) + 1


def write_mesh(filename_out, f_x, f_y, section_bot, section_top, dpi):
    n_vertical = len(f_x)
    n_horizontal = len(section_bot)

    n_points = n_vertical * n_horizontal

    alpha = hermite(n_vertical)

    sections = []

    for i in range(n_vertical):
        xyz = np.zeros((n_horizontal, 3))
        xyz[:, 2] = f_y[i]
        xyz[:, 0] = (section_bot[:, 0] * alpha[i] + section_top[:, 0] * (1 - alpha[i])) * f_x[i]
        xyz[:, 1] = (section_bot[:, 1] * alpha[i] + section_top[:, 1] * (1 - alpha[i])) * f_x[i]
        sections.append(xyz)

    xyz_all = np.vstack(sections)
    xyz_mm = px_to_mm(xyz_all, dpi)

    n_face = 2 * (n_vertical - 1) * n_horizontal
    triangles = np.zeros((n_face, 3))

    f = 0
    for i in range(n_vertical - 1):
        for j in range(n_horizontal - 1):
            triangles[f, 0] = j + i * n_horizontal
            triangles[f, 1] = (j + 1) + i * n_horizontal
            triangles[f, 2] = (j + 1) + (i + 1) * n_horizontal
            triangles[f + 1, 0] = j + i * n_horizontal
            triangles[f + 1, 1] = j + (i + 1) * n_horizontal
            triangles[f + 1, 2] = (j + 1) + (i + 1) * n_horizontal

            f += 2

        triangles[f, 0] = (n_horizontal-1) + i * n_horizontal
        triangles[f, 1] = 0 + i * n_horizontal
        triangles[f, 2] = 0 + (i + 1) * n_horizontal
        triangles[f + 1, 0] = (n_horizontal-1) + i * n_horizontal
        triangles[f + 1, 1] = (n_horizontal-1) + (i + 1) * n_horizontal
        triangles[f + 1, 2] = 0 + (i + 1) * n_horizontal

        f += 2

    write_ply(filename_out, xyz_mm, triangles)


def bounding_box(xy):
    xmin, xmax = np.min(xy[:, 0]), np.max(xy[:, 0])
    ymin, ymax = np.min(xy[:, 1]), np.max(xy[:, 1])
    b = np.array([
        (xmin, ymin),
        (xmin, ymax),
        (xmax, ymax),
        (xmax, xmin)
    ], dtype=np.int32)
    return b


def main():
    args, _ = parse_arguments()

    filename_in = args.input

    if args.output == "":
        filename_out = filename_in.replace(".png", ".ply")
    else:
        filename_out = args.output

    if args.dpi == -1:
        m = re.match(r".+_(\d+)_DPI\.png$", filename_in)
        if m is None:
            raise ValueError(f"DPI not specified and missing in filename: '{filename_in}'")
        dpi = int(m.group(1))
    else:
        dpi = args.dpi

    show = args.show

    n_horizontal = 256

    print(f"Reading '{filename_in}'")

    img = cv2.imread(args.input, cv2.IMREAD_UNCHANGED)
    img_draw = np.copy(img)

    h, w, _ = img.shape

    img_gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    img_thresh = threshold(img_gray, dpi)

    imshow(img_thresh)

    pt1, pt2 = find_axis(img_thresh)

    cv2.circle(img_draw, pt1, radius=int(mm_to_px(1.5, dpi)), color=(0, 0, 255), thickness=cv2.FILLED)
    cv2.circle(img_draw, pt2, radius=int(mm_to_px(1.5, dpi)), color=(0, 0, 255), thickness=cv2.FILLED)

    origin = np.array(pt2, dtype=np.float32)
    y_length = np.linalg.norm(pt1 - pt2)
    y_axis = (pt1 - pt2) / y_length
    x_axis = np.array([-y_axis[1], y_axis[0]])

    def to_coords(pt):
        if isinstance(pt, np.ndarray) and len(pt.shape) == 2:
            mat = np.array([
                x_axis,
                y_axis
            ])
            pt_shift = pt - origin[np.newaxis, :]
            return pt_shift @ mat.T
        else:
            return np.array([np.dot(x_axis, pt - origin), np.dot(y_axis, pt - origin)])

    def from_coords(pt):
        if isinstance(pt, np.ndarray) and len(pt.shape) == 2:
            return origin[np.newaxis, :] + x_axis[np.newaxis, :] * pt[:, 0:1] + y_axis[np.newaxis, :] * pt[:, 1:2]
        else:
            return origin + x_axis * pt[0] + y_axis * pt[1]

    def get_ct_length(ct):
        return np.sum(np.linalg.norm(ct[1:, 0, :] - ct[:-1, 0, :], axis=1))

    # RIGHT SIDE
    img_masked = np.copy(img_thresh)
    eps = mm_to_px(3.0, dpi)
    cv2.fillPoly(img_masked, np.array([[
        from_coords([eps, -eps]),
        from_coords([eps, y_length + eps]),
        [0, 0],
        [0, h]
    ]], dtype=np.int32), color=(0, 0, 0))

    cts, hierarchy = cv2.findContours(img_masked, mode=cv2.RETR_EXTERNAL, method=cv2.CHAIN_APPROX_TC89_KCOS)

    # cv2.drawContours(img_draw, cts, -1, lineType=cv2.LINE_8, thickness=int(mm_to_px(1, dpi)), color=(0, 255, 0))

    k_filt = 15
    k_half = (k_filt - 1) // 2

    cts_sorted = sorted(cts, key=lambda x: get_ct_length(x))

    if len(cts) == 0:
        print("Error: no shape found")
        return

    ct = cts_sorted[-1]

    if px_to_mm(get_ct_length(ct), dpi) < 40.0:
        print("Error: no shape found")

    if show:
        b = bounding_box(ct[:, 0, :])
        cv2.rectangle(img_draw,
                      b[0],
                      b[2],
                      (0, 128, 255), int(mm_to_px(0.3, dpi)))

    xy_profile = to_coords(ct[:, 0, :])

    # mask = (xy_profile[2:, 1] - xy_profile[:-2, 1]) > 0

    # xy_profile = xy_profile[1:-1, :][mask, :]
    xy_profile = xy_profile[1:-1, :]

    # i_start = np.argmin(xy_profile[:, 1])
    i_start = np.argmin(xy_profile[:, 0])
    i_end = np.argmax(xy_profile[:, 1])

    if i_start > i_end:
        i_start, i_end = i_end, i_start

    print(i_start)
    print(i_end)

    xy_profile = xy_profile[i_start:i_end]

    # plt.figure()
    # plt.plot(xy_profile[:, 0], xy_profile[:, 1])
    # plt.axis("equal")
    # plt.show()

    print(xy_profile.shape)

    y_length_used = xy_profile[-1, 1] - xy_profile[0, 1]

    # resolution
    n_points = int(px_to_mm(y_length_used, dpi) / 0.5)

    # EXPERIMENT
    f_x_pad = np.pad(xy_profile[:, 0], [k_half, k_half], "edge")
    f_x = np.convolve(f_x_pad, np.ones((k_filt,)) / k_filt, "valid")

    f_y_pad = np.pad(xy_profile[:, 1], [k_half, k_half], "edge")
    f_y = np.convolve(f_y_pad, np.ones((k_filt,)) / k_filt, "valid")

    """
    f_y = np.linspace(xy_profile[0, 1], xy_profile[-1, 1], n_points)

    f_x = np.interp(f_y, xy_profile[:, 1], xy_profile[:, 0])

    f_y -= f_y[0]

    f_x_pad = np.pad(f_x, [k_half, k_half], "edge")
    f_x = np.convolve(f_x_pad, np.ones((k_filt,)) / k_filt, "valid")
    """

    # LEFT SIDE
    # if show:
    #     imshow(img_masked, waitkey=False)

    img_masked = np.copy(img_thresh)
    eps = mm_to_px(3.0, dpi)

    cv2.fillPoly(img_masked, np.array([[
        from_coords([-eps, y_length + eps]),
        from_coords([-eps, -eps]),
        [w, h],
        [w, 0]
    ]], dtype=np.int32), color=(0, 0, 0))

    cts, hierarchy = cv2.findContours(img_masked, mode=cv2.RETR_EXTERNAL, method=cv2.CHAIN_APPROX_TC89_KCOS)

    # cv2.drawContours(img_draw, cts, -1, lineType=cv2.LINE_8, thickness=int(mm_to_px(1, dpi)), color=(255, 255, 0))

    sections = []

    for ct in cts:
        ct_center = np.mean(ct[:, 0, :], axis=0)

        if ct_center[0] < 20:
            continue

        xy_center = to_coords(ct_center)
        if px_to_mm(abs(xy_center[0]), dpi) < 20:
            continue

        ct_len = np.sum(np.linalg.norm(ct[1:, 0, :] - ct[:-1, 0, :], axis=1))
        ct_len_mm = px_to_mm(ct_len, dpi)

        if ct_len_mm < 30.0:
            continue

        sections.append(to_coords(ct[:, 0, :]))

    if len(sections) == 0:
        if show:
            imshow(img_draw)

        theta = 2 * math.pi * np.arange(n_horizontal) / n_horizontal
        section = np.zeros((n_horizontal, 2))
        section[:, 0] = np.cos(theta)
        section[:, 1] = np.sin(theta)
        write_mesh(filename_out, f_x, f_y, section, section, dpi)
    if len(sections) == 1:
        if show:
            b = bounding_box(from_coords(sections[0]))
            cv2.rectangle(img_draw,
                          b[0],
                          b[2],
                          (255, 128, 0), int(mm_to_px(0.3, dpi)))

            imshow(img_draw)
        section = normalize_and_filter_section(sections[0], n_samp=n_horizontal)

        write_mesh(filename_out, f_x, f_y, section, section, dpi)
    if len(sections) >= 2:
        sections = sorted(sections, key=lambda x: np.mean(x[:, 1]))

        if show:
            b = bounding_box(from_coords(sections[0]))

            cv2.rectangle(img_draw,
                          b[0],
                          b[2],
                          (255, 128, 0), int(mm_to_px(0.3, dpi)))
            b = bounding_box(from_coords(sections[-1]))
            cv2.rectangle(img_draw,
                          b[0],
                          b[2],
                          (128, 0, 255), int(mm_to_px(0.3, dpi)))

            imshow(img_draw)

        section_bot = normalize_and_filter_section(sections[0], n_samp=n_horizontal)
        section_top = normalize_and_filter_section(sections[-1], n_samp=n_horizontal)

        if show:
            plt.figure()
            plt.subplot(1, 3, 1)
            plt.plot(f_x, f_y)
            plt.axis("equal")

            plt.subplot(1, 3, 2)
            plt.plot(section_bot[:, 0], section_bot[:, 1], 'r')
            plt.axis("equal")

            plt.subplot(1, 3, 3)
            plt.plot(section_top[:, 0], section_top[:, 1], 'b')
            plt.axis("equal")

            plt.show()

        write_mesh(filename_out, f_x, f_y, section_bot, section_top, dpi)

    print(f"Wrote 3D model as '{filename_out}'")


if __name__ == "__main__":
    main()
