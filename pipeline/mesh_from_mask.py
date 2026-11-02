"""silhouette_mask.png -> evenly tessellated plate mesh (PLY): caps with interior vertices + side walls.
Units: same as build script expects (mm in SVG space -> we output metres, height normalised to FIG_H)."""
import cv2, numpy as np, json, os
from scipy.spatial import Delaunay
W = os.path.dirname(os.path.abspath(__file__))
import os as _os
FIG_H = float(_os.environ.get('PLATE_FIG_H', '0.578')); THICK = 0.040/0.600*FIG_H
mask = cv2.imread(os.path.join(W,'silhouette_mask.png'), 0)
mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))   # reach the paint's outer edge (~2px)
meta = json.load(open(os.path.join(W,'silhouette_meta.json')))
x0,y0,bw,bh = meta['bbox']
S = FIG_H / bh                      # metres per pixel
def to_m(px, py): return ((px-(x0+bw/2))*S, (y0+bh-py)*S)   # x centred, z up from feet
# --- boundary: smooth closed curve through the traced contour (Chaikin corner cutting x4 on the raw contour,
#     then uniform resampling at ~2.5mm). This removes the polygonal facets of approxPolyDP.
cnts, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
SP = 0.003 / S                      # resample spacing in px
def chaikin(P, iters=4):
    for _ in range(iters):
        Q = []
        n = len(P)
        for i in range(n):
            a, b = P[i], P[(i+1) % n]
            Q.append(0.75*a + 0.25*b); Q.append(0.25*a + 0.75*b)
        P = np.array(Q)
    return P
loops = []
for c in cnts:
    if cv2.contourArea(c) < 300: continue
    raw = c[:,0,:].astype(float)
    # light pre-simplification (0.6px) to drop pixel stair-steps, then Chaikin smoothing
    ap = cv2.approxPolyDP(c, 0.6, True)[:,0,:].astype(float)
    sm = chaikin(ap, 4)
    # also a small gaussian along the loop to kill residual jitter
    k = 9; kern = np.exp(-0.5*((np.arange(k)-k//2)/(k/4))**2); kern /= kern.sum()
    smx = np.convolve(np.concatenate([sm[-k:,0], sm[:,0], sm[:k,0]]), kern, 'same')[k:-k]
    smy = np.convolve(np.concatenate([sm[-k:,1], sm[:,1], sm[:k,1]]), kern, 'same')[k:-k]
    sm = np.stack([smx, smy], 1)
    pts = np.vstack([sm, sm[:1]]); seg = np.linalg.norm(np.diff(pts,axis=0),axis=1); L = seg.sum()
    n = max(16, int(L/SP)); d = np.linspace(0, L, n, endpoint=False); cum = np.concatenate([[0], np.cumsum(seg)])
    out = []
    for dd in d:
        i = min(np.searchsorted(cum, dd, side='right')-1, len(seg)-1); t = (dd-cum[i])/max(seg[i],1e-9)
        out.append(pts[i]*(1-t)+pts[i+1]*t)
    loops.append(np.array(out))
# --- interior hex grid (inside mask eroded by 3mm)
er = cv2.erode(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(0.0035/S)*2+1,)*2))
G = 0.007 / S
pts_in = []
row = 0
for py in np.arange(y0, y0+bh, G*0.866):
    off = (G/2) if row % 2 else 0; row += 1
    for px in np.arange(x0+off, x0+bw, G):
        if er[int(py), int(px)] > 0: pts_in.append((px, py))
pts_in = np.array(pts_in)
bpts = np.vstack(loops)
allp = np.vstack([bpts, pts_in])
tri = Delaunay(allp)
# --- constrained Delaunay: every contour segment must be an edge of the triangulation, otherwise the cap's boundary
#     and the side walls (built from the contour segments) do not match and the slab has holes (the old plate had
#     ~100 open wall edges; stretched 8x in the ankle they showed as cracks). Sloan's edge-flip enforcement.
def enforce_constraints(points, simplices, segments):
    tris = {tuple(sorted(t)): tuple(t) for t in simplices}     # key -> oriented tri (orientation not needed)
    edge_tris = {}
    def add_tri(t):
        k = tuple(sorted(t)); tris[k] = t
        for i in range(3):
            e = tuple(sorted((t[i], t[(i+1)%3]))); edge_tris.setdefault(e, set()).add(k)
    def rem_tri(k):
        t = tris.pop(k)
        for i in range(3):
            e = tuple(sorted((t[i], t[(i+1)%3]))); edge_tris[e].discard(k)
            if not edge_tris[e]: del edge_tris[e]
    for k in list(tris.keys()): add_tri(tris[k])
    def orient(p, q, r): return (q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0])
    def crosses(a, b, c, d):      # proper crossing of segments ab and cd (no shared endpoints)
        if len({a,b,c,d}) < 4: return False
        P = points
        o1, o2 = orient(P[a],P[b],P[c]), orient(P[a],P[b],P[d]); o3, o4 = orient(P[c],P[d],P[a]), orient(P[c],P[d],P[b])
        return (o1*o2 < 0) and (o3*o4 < 0)
    fixed = 0; failed = 0
    for (a, b) in segments:
        if tuple(sorted((a,b))) in edge_tris: continue
        # edges crossing ab
        queue = [e for e in edge_tris if crosses(a, b, e[0], e[1])]
        guard = 0
        while queue and guard < 20000:
            guard += 1
            e = queue.pop(0)
            if e not in edge_tris: continue
            ts = list(edge_tris[e])
            if len(ts) != 2: continue
            c, d = e
            t1, t2 = tris[ts[0]], tris[ts[1]]
            a1 = [v for v in t1 if v not in e][0]; a2 = [v for v in t2 if v not in e][0]
            # convex quad a1-c-a2-d ?  (a1,a2 must be on opposite sides of cd and c,d on opposite sides of a1a2)
            if not crosses(a1, a2, c, d): queue.append(e); continue
            rem_tri(ts[0]); rem_tri(ts[1]); add_tri((a1, c, a2)); add_tri((a1, a2, d))
            ne = tuple(sorted((a1, a2)))
            if crosses(a, b, a1, a2): queue.append(ne)
        if tuple(sorted((a,b))) in edge_tris: fixed += 1
        else: failed += 1
    return np.array(list(tris.values())), fixed, failed
segs = []; idx = 0
for lp in loops:
    n = len(lp); segs += [(idx+i, idx+(i+1) % n) for i in range(n)]; idx += n
simp, nfixed, nfailed = enforce_constraints(allp, tri.simplices, segs)
print('constraint edges enforced:', nfixed, 'failed:', nfailed)
# inside/outside by topology, not by the mask pixel under the centroid: with the contour in the edge set the
# triangulation is partitioned by the contour; seed with the triangles on the paint side of each contour segment
# and flood through non-contour edges. (Sliver triangles along a concave contour have centroids that land outside
# the mask and used to be dropped, leaving 146 wall segments without a cap -> open edges -> cracks when stretched.)
segset = set(tuple(sorted(sg)) for sg in segs)
tri_of_edge = {}
for ti, t in enumerate(simp):
    for i in range(3):
        tri_of_edge.setdefault(tuple(sorted((t[i], t[(i+1)%3]))), []).append(ti)
def side_of(a, b, c): return np.sign((allp[b,0]-allp[a,0])*(allp[c,1]-allp[a,1]) - (allp[b,1]-allp[a,1])*(allp[c,0]-allp[a,0]))
inside = np.zeros(len(simp), dtype=bool); seeded = set()
idx = 0
for lp in loops:
    n = len(lp)
    # which side of the travel direction is paint: probe the mask a few px off the segment midpoints
    votes = 0
    for i in range(0, n, max(1, n//40)):
        a, b = lp[i], lp[(i+1)%n]; m = (a+b)/2; d = b-a; d = d/ (np.linalg.norm(d)+1e-9); nl = np.array([-d[1], d[0]])
        for sgn in (1, -1):
            p = m + sgn*nl*4
            if 0 <= int(p[1]) < mask.shape[0] and 0 <= int(p[0]) < mask.shape[1] and mask[int(p[1]), int(p[0])] > 0: votes += sgn
    paint_side = 1 if votes >= 0 else -1          # +1: paint on the left of a->b
    for i in range(n):
        a, b = idx+i, idx+(i+1)%n
        for ti in tri_of_edge.get(tuple(sorted((a,b))), []):
            c = [v for v in simp[ti] if v not in (a,b)][0]
            if side_of(a, b, c) == paint_side: inside[ti] = True; seeded.add(ti)
    idx += n
from collections import deque
q = deque(seeded)
while q:
    ti = q.popleft(); t = simp[ti]
    for i in range(3):
        e = tuple(sorted((t[i], t[(i+1)%3])))
        if e in segset: continue
        for tj in tri_of_edge.get(e, []):
            if not inside[tj]: inside[tj] = True; q.append(tj)
faces2d = simp[inside]
# watertight check: every contour segment must be used by exactly one kept triangle
from collections import Counter
ec = Counter(tuple(sorted((t[i], t[(i+1)%3]))) for t in faces2d for i in range(3))
bad = [sg for sg in segs if ec.get(tuple(sorted(sg)), 0) != 1]
print('boundary pts', len(bpts), 'interior', len(pts_in), 'tris', len(faces2d), 'contour segments not matched by exactly one cap triangle:', len(bad))
# --- build 3D: front cap (y=-T/2, normal -Y), back cap (y=+T/2), walls along each loop
N = len(allp); T = THICK
V = []
for (px,py) in allp:
    x,z = to_m(px,py); V.append((x,0.0,z))        # front face on the floor plane when lying flat
for (px,py) in allp:
    x,z = to_m(px,py); V.append((x,T,z))          # thickness goes below the floor / behind the figure
F = []
for a,b,c in faces2d:
    # ensure consistent winding: front cap should face -Y. Compute 2D orientation (image y down => flip)
    ax,ay = allp[a]; bx,by = allp[b]; cx,cy = allp[c]
    cross = (bx-ax)*(cy-ay)-(by-ay)*(cx-ax)
    if cross > 0: a,b,c = a,c,b   # make CCW in image space (y down)
    F.append((a,b,c)); F.append((c+N,b+N,a+N))
# walls
idx = 0
for lp in loops:
    n = len(lp)
    for i in range(n):
        j = (i+1) % n; a, b = idx+i, idx+j
        F.append((a,b,b+N)); F.append((a,b+N,a+N))
    idx += n
# write PLY
with open(os.path.join(W, os.environ.get('PLATE_PLY', 'plate.ply')),'w') as f:
    f.write(f"ply\nformat ascii 1.0\nelement vertex {len(V)}\nproperty float x\nproperty float y\nproperty float z\nelement face {len(F)}\nproperty list uchar int vertex_indices\nend_header\n")
    for v in V: f.write(f"{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
    for fc in F: f.write(f"3 {fc[0]} {fc[1]} {fc[2]}\n")
json.dump([[list(to_m(px,py)) for (px,py) in lp] for lp in loops], open(os.path.join(W,'outline_loops.json'),'w'))
print('PLY written: verts', len(V), 'faces', len(F), 'loops', [len(l) for l in loops])
