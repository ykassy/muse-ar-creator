"""prep_mask.py - transparent PNG -> silhouette_mask.png + silhouette_meta.json + edge_color.json

Generalised replacement for the in-house extract_silhouette.py: the in-house front half pulled the
silhouette out of a floor photo by colour (Lab a* red detection + glare repair). Here the
artwork is already cut out, so the mask is simply the alpha channel: mask = (alpha > 127).
Everything downstream (mesh_from_mask.py) consumes the same two files as before.

Usage: prep_mask.py <input.png> <jobdir>
Writes into <jobdir>: silhouette_mask.png, silhouette_meta.json, edge_color.json, texture.png
"""
import cv2, numpy as np, json, os, sys, shutil

def main():
    src, jobdir = sys.argv[1], sys.argv[2]
    os.makedirs(jobdir, exist_ok=True)
    img = cv2.imread(src, cv2.IMREAD_UNCHANGED)
    if img is None or img.ndim < 3 or img.shape[2] < 4:
        raise SystemExit(f'input must be an RGBA PNG: {src}')
    h, w = img.shape[:2]
    alpha = img[:, :, 3]
    mask = (alpha > 127).astype(np.uint8) * 255

    # drop dust specks: components smaller than 0.05% of all opaque pixels
    n, lab, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), 8)
    if n > 2:
        total = int((mask > 0).sum())
        keep = np.zeros_like(mask)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= max(24, 0.0005 * total):
                keep[lab == i] = 255
        mask = keep

    # representative edge colour: median RGB of opaque pixels touching
    # transparency. Sampled BEFORE the erosion below (after erosion the mask
    # no longer touches transparency and there would be nothing to sample).
    dil = cv2.dilate((alpha <= 127).astype(np.uint8), np.ones((3, 3), np.uint8))
    edge = (mask > 0) & (dil > 0)
    bgr = img[:, :, :3][edge].astype(np.float64)
    med_bgr = np.median(bgr, axis=0) / 255.0          # sRGB 0..1, BGR order
    edge_rgb_srgb = [float(med_bgr[2]), float(med_bgr[1]), float(med_bgr[0])]

    # Shrink the silhouette ~2px: Chaikin smoothing in mesh_from_mask can push
    # the contour slightly outward, and any plate area outside the art line
    # shows the plate's inside through the alpha cutout (the 'thickness in
    # front' artifact). Eroding keeps the whole plate inside the artwork.
    mask = cv2.erode(mask, np.ones((3, 3), np.uint8), iterations=2)

    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        raise SystemExit('empty silhouette (no alpha > 127 pixels)')
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    bbox = [x0, y0, x1 - x0 + 1, y1 - y0 + 1]

    cv2.imwrite(os.path.join(jobdir, 'silhouette_mask.png'), mask)
    json.dump({'bbox': bbox, 'img': [w, h]}, open(os.path.join(jobdir, 'silhouette_meta.json'), 'w'))
    json.dump({'rgb_srgb': edge_rgb_srgb, 'edge_px': int(edge.sum())},
              open(os.path.join(jobdir, 'edge_color.json'), 'w'), indent=1)
    # texture = the SAME bbox region the plate is built from (keeps build_plate's
    # plate-normalised UVs aligned with the artwork), with the transparent area
    # FLOODED in the edge colour and alpha forced opaque. The artwork material
    # is exported OPAQUE (no alphaTest): a rim vertex that lands outside the art
    # line now shows an in-plane edge-coloured border instead of a see-through
    # hole into the plate's inside.
    x0, y0, bw, bh = bbox
    crop = img[y0:y0 + bh, x0:x0 + bw].astype(np.float64)
    a = crop[:, :, 3:4] / 255.0
    edge_bgr = np.array([edge_rgb_srgb[2], edge_rgb_srgb[1], edge_rgb_srgb[0]]) * 255.0
    rgb = crop[:, :, :3] * a + edge_bgr * (1.0 - a)
    tex = np.dstack([rgb, np.full((bh, bw), 255.0)]).astype(np.uint8)
    cv2.imwrite(os.path.join(jobdir, 'texture.png'), tex)
    print(f'prep OK: img {w}x{h} bbox {bbox} opaque {(mask>0).sum()} edge_rgb_srgb '
          f'{[round(c,3) for c in edge_rgb_srgb]} (from {int(edge.sum())} edge px)')

if __name__ == '__main__':
    main()
