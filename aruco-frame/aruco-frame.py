import datetime
import os
import json
import sys
import argparse

import cv2
import numpy as np

from utils import solve_lens, misc


def parse_arguments():
    usage_text = (
        "Extracts the image from an image containing an aruco frame"
    )
    parser = argparse.ArgumentParser(description=usage_text)
    parser.add_argument("-i", "--input", type=str,
                        help="Input filename.")
    parser.add_argument("-o", "--output", type=str, default="",
                        help="Output filename (default: <filename_in>_extracted.png).")
    parser.add_argument("-d", "--dpi", type=int, default=-1,
                        help="Manual output DPI (default: auto).")
    parser.add_argument("-s", "--show", action="store_true",
                        help="Show debug image.")
    parser.add_argument("-c", "--config", type=str, default="./config/config.json",
                        help="Frame configuration file (default: ./config/config.json).")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Verbose mode (default: false).")
    return parser.parse_known_args()


def imshow(img, h_view=700, win_name="debug"):
    h, w = img.shape[:2]
    w_view = int(h_view * w / h)
    cv2.imshow(win_name, cv2.resize(img, (w_view, h_view), interpolation=cv2.INTER_AREA))
    cv2.waitKey(0)


def extract_image(img, proj, config, dots_per_mm, dist_params=None):
    h, w, c = img.shape

    m = config["margins"]["inner_content"]
    xmin = m
    xmax = config["width"] - m
    ymin = m
    ymax = config["height"] - m

    h_out = int(dots_per_mm * (ymax - ymin))
    w_out = int(dots_per_mm * (xmax - xmin))

    x = np.linspace(xmin, xmax, w_out)
    y = np.linspace(ymax, ymin, h_out)
    xx, yy = np.meshgrid(x, y)

    xy_list = np.ones((h_out * w_out, 2))
    xy_list[:, 0] = xx.flatten()
    xy_list[:, 1] = yy.flatten()
    uv_src = apply_affine(proj, xy_list)

    if dist_params is not None:
        k1, k2, uc, vc = dist_params[:]
        mat = np.array([[w, 0, uc], [0, w, vc], [0, 0, 1]], dtype=np.float32)
        dist_coeffs = np.array([[0, 0, 0, 0, 0, k1, k2, 0]], dtype=np.float32)
        out = cv2.undistortPoints(uv_src, mat, dist_coeffs, P=mat)
        uv_src = out[:, 0, :]

    map1 = uv_src[:, 0].reshape((h_out, w_out)).astype(np.float32)
    map2 = uv_src[:, 1].reshape((h_out, w_out)).astype(np.float32)

    # plt.figure()
    # plt.imshow(map1)
    # plt.figure()
    # plt.imshow(map2)
    # plt.show()

    img_out = cv2.remap(img, map1, map2, interpolation=cv2.INTER_CUBIC)

    return img_out


def find_aruco(img):
    aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    params = cv2.aruco.DetectorParameters()
    params.adaptiveThreshWinSizeMax = 40
    params.useAruco3Detection = True
    corners, ids, rejected = cv2.aruco.detectMarkers(img, dictionary=aruco_dict, parameters=params)
    if ids is None:
        return {}
    else:
        corners_dict = {ids[k][0]: corners[k][0, :, :] for k in range(len(ids))}
        return corners_dict


def identify_frame(img, config_frames, debug=False):
    corners_dict = find_aruco(img)

    if debug:
        img_view = np.copy(img)
        for c in corners_dict.values():
            for uv in c[:, :]:
                cv2.circle(img_view, uv.astype(np.int32), radius=30, color=(0, 0, 255), thickness=cv2.FILLED)

        imshow(img_view)

    name_found = None
    for name in config_frames:
        match = True
        for aruco_id in config_frames[name]["aruco_id"]:
            if aruco_id not in corners_dict:
                match = False
                break
        if match:
            name_found = name
            break
    return name_found


def get_aruco_features(img, config):
    corners_dict_all = find_aruco(img)
    corners_dict = {k: corners_dict_all[k] for k in config["aruco_id"]}
    centers_dict = {k: np.mean(corners_dict[k], axis=0) for k in corners_dict}

    xy_array = np.zeros((4, 2))
    uv_array = np.zeros((4, 2))

    for i in range(4):
        xy_array[i, :] = config["aruco_pos"][i]
        uv_array[i, :] = centers_dict[config["aruco_id"][i]]

    return xy_array, uv_array


def apply_affine(a, xy):
    n = len(xy)
    xyz = np.ones((n, 3))
    xyz[:, :2] = xy
    uvw = xyz @ a.T
    uv = uvw[:, :2] / uvw[:, 2:]
    return uv


def get_corner_features(img_gray, proj, config):
    n_points = sum(len(edge) for edge in config["corner_pos"])

    xy_feats = np.zeros((n_points, 2))
    uv_feats_approx = np.zeros((n_points, 2))

    k = 0
    for edge in config["corner_pos"]:
        n_edge = len(edge)
        xy_feats[k:k + n_edge, :] = np.array(edge)
        uv_feats_approx[k:k + n_edge] = apply_affine(proj, xy_feats[k:k + n_edge, :])
        k += n_edge

    # adjust search region to resolution
    search_mm = 0.7 * config["corner_size"] / 2

    cross_xy = np.zeros((4 * n_points, 2), dtype=np.float32)
    cross_xy[0::4, :] = xy_feats - np.array([search_mm, 0])
    cross_xy[1::4, :] = xy_feats + np.array([search_mm, 0])
    cross_xy[2::4, :] = xy_feats - np.array([0, search_mm])
    cross_xy[3::4, :] = xy_feats + np.array([0, search_mm])

    cross_uv = apply_affine(proj, cross_xy)
    cross_uv_r = cross_uv.reshape(n_points, 4, 2)

    span_uv = (np.max(cross_uv_r, axis=1) - np.min(cross_uv_r, axis=1)) / 2
    search_uv = np.mean(span_uv, axis=0).astype(np.int32)
    # print(search_uv)

    criteria = (cv2.TERM_CRITERIA_COUNT + cv2.TERM_CRITERIA_EPS, 40, 0.001)
    ret = cv2.cornerSubPix(img_gray,
                           uv_feats_approx[:, np.newaxis, :].astype(np.float32),
                           (search_uv[0], search_uv[1]),
                           (-1, -1),
                           criteria)
    uv_feats = ret[:, 0, :]
    # return xy_feats, uv_feats_approx

    return xy_feats, uv_feats


def get_dots_per_mm(xy, uv, use_max=True):
    xy_dist = np.zeros((4,))
    uv_dist = np.zeros((4,))
    for i in range(-1, 3):
        xy_dist[i] = np.linalg.norm(xy[i + 1] - xy[i])
        uv_dist[i] = np.linalg.norm(uv[i + 1] - uv[i])
    if use_max:
        return np.max(uv_dist / xy_dist)
    else:
        return np.mean(uv_dist / xy_dist)


def process_image(img, config_frames, solve_dist=False, view=False, view_radius=16, verbose=False, dpi=None):
    h, w = img.shape[:2]

    if len(img.shape) == 2:
        img_gray = img
        img_rgb = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    else:
        img_gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        img_rgb = img

    frame_name = identify_frame(img_rgb, config_frames)

    if verbose:
        print(f"frame found: '{frame_name}'")

    if frame_name is None:
        raise RuntimeError("No frame found!")

    config = config_frames[frame_name]

    xy_a, uv_a = get_aruco_features(img_rgb, config)
    proj = misc.solve_affine(xy_a, uv_a)

    if dpi is None:
        dpi = int(get_dots_per_mm(xy_a, uv_a) * 25.4)
    dots_per_mm = dpi / 25.4

    if verbose:
        print(f"DPI: {dpi}")

    xy_c, uv_c = get_corner_features(img_gray, proj, config)

    proj_fine = misc.solve_affine(xy_c, uv_c)
    err1 = solve_lens.xy_error(xy_c, uv_c, proj)
    err2 = solve_lens.xy_error(xy_c, uv_c, proj_fine)
    if verbose:
        print(f"Error init.     : {np.mean(np.linalg.norm(err1, axis=1)):.3f} mm")
        print(f"Error refined   : {np.mean(np.linalg.norm(err2, axis=1)):.3f} mm")

    if view:
        img_view = np.copy(img_rgb)
        for uv in uv_a:
            cv2.circle(img_view, uv.astype(np.int32), radius=view_radius, color=(255, 200, 0), thickness=cv2.FILLED)
        for uv in uv_c:
            cv2.circle(img_view, uv.astype(np.int32), radius=view_radius, color=(0, 0, 255), thickness=cv2.FILLED)
        imshow(img_view, win_name="features")
        # cv2.imwrite("view.jpg", img_view)

    if solve_dist:
        params = solve_lens.solve_distortion(xy_c, uv_c, proj_fine, w, w, h)

        for i in range(4):
            uv_u = solve_lens.undistort(params, uv_c, w)
            proj_fine = misc.solve_affine(xy_c, uv_u)
            params = solve_lens.solve_distortion(xy_c, uv_c, proj_fine, w, w, h)

        uv_u = solve_lens.undistort(params, uv_c, w)
        err3 = solve_lens.xy_error(xy_c, uv_u, proj_fine)
        if verbose:
            print(f"Error lens dist.: {np.mean(np.linalg.norm(err3, axis=1)):.3f} mm")

        img_out = extract_image(img_rgb, proj_fine, config, dots_per_mm, dist_params=params)
    else:
        img_out = extract_image(img_rgb, proj_fine, config, dots_per_mm)

    if view:
        imshow(img_out, win_name="out")

    # handle upside down case
    if uv_a[0][1] < uv_a[2][1]:
        img_out = cv2.rotate(img_out, cv2.ROTATE_180)

    h_out, w_out, _ = img_out.shape

    if verbose:
        print(f"Dots per mm: {dots_per_mm:.2f}")
        print(f"Dots per in: {dpi}")
        print(f"Resolution: {w_out} x {h_out}")

    return img_out, dpi


def load_config_frames(filename):
    head, tail = os.path.split(filename)

    with open(filename, "r") as f:
        config_all = json.load(f)

    config = {}
    for frame_name, frame_filename in config_all.items():
        with open(os.path.join(head, frame_filename), "r") as f:
            config[frame_name] = json.load(f)

    return config


def main():
    args, _ = parse_arguments()

    filename_in = args.input

    print(f"Processing: '{filename_in}' ...")

    img = cv2.imread(filename_in, cv2.IMREAD_UNCHANGED)

    config_frames = load_config_frames(args.config)

    if args.dpi == -1:
        img_out, dpi = process_image(img, config_frames,
                                     solve_dist=True, view=args.show, verbose=args.verbose)
    else:
        img_out, dpi = process_image(img, config_frames,
                                     solve_dist=True, view=args.show, verbose=args.verbose, dpi=args.dpi)

    if args.output == "":
        filename_out = os.path.splitext(filename_in)[0] + f"_{dpi}_DPI.png"
    else:
        filename_out = args.output

    head_out, _ = os.path.split(filename_out)
    if head_out != "":
        os.makedirs(head_out, exist_ok=True)

    print(f"Using {dpi} DPI")

    print(f"Writing: '{filename_out}' ...")

    misc.writePNGwithdpi(filename_out, img_out, dpi=(dpi, dpi))

    print("Done.")


if __name__ == "__main__":
    main()
