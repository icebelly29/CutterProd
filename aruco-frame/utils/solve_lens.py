import numpy as np
import scipy


def undistort(params, uv, f):
    k1, k2 = params[:2]
    uv_c = params[2:4]
    r2 = np.sum(np.square((uv - uv_c) / f), axis=1, keepdims=True)
    coeff = 1 / (1 + k1 * r2 + k2 * r2 * r2)
    # coeff = (1 + k1 * r2 + k2 * r2 * r2)

    return uv_c + (uv - uv_c) * coeff


def distort(params, uv, f, print_info=False):
    n_points = len(uv)

    err = lambda x: undistort(params, x, f) - uv
    loss = lambda x: np.mean(np.sum(err(x.reshape(n_points, 2)) ** 2, axis=1))

    x0 = uv.flatten()

    result = scipy.optimize.minimize(loss, x0, method="COBYLA")

    if print_info:
        print(result)

    uv_d = result.x.reshape(n_points, 2)
    return uv_d


def xy_error(xy, uv, P):
    n_points = len(uv)

    P_inv = np.linalg.inv(P)
    P_inv /= P_inv[2, 2]

    uv_ext = np.ones((n_points, 3))
    uv_ext[:, :2] = uv
    xy2_ext = P_inv @ uv_ext.T
    xy2 = xy2_ext[:2, :].T / xy2_ext[2:, :].T

    return xy2 - xy


def xy_loss(params, xy, uv, proj, f, use_mae=False):
    uv_u = undistort(params, uv, f)
    err = xy_error(xy, uv_u, proj)
    if use_mae:
        return np.mean(np.linalg.norm(err, axis=1))
    else:
        return np.mean(np.sum(err * err, axis=1))


def solve_distortion(xy, uv, proj, f, w, h, print_info=False):
    x0 = np.array([0, 0, w / 2, h / 2])
    result = scipy.optimize.minimize(xy_loss, x0, args=(xy, uv, proj, f))
    xf = result.x

    if print_info:
        print("before:")
        print(f"x={x0}")
        print(f"loss={xy_loss(x0, uv, xy, proj, f)}")
        print("after:")
        print(f"x={xf}")
        print(f"loss={xy_loss(xf, uv, xy, proj, f)}")

    return xf
