"""build_plate.py - Blender build: textured semi-3D plate GLB from plate.ply.

Generalised from our in-house floor-AR plate build. Kept from in-house:
PLY plate import, rim bevel, material split by face normal (normal.y < -0.7 -> artwork,
everything else -> solid colour), legs->belly->head bone chain with height-smoothstep
weights, squash & stretch sx = 1/sqrt(sy) baked per frame with LINEAR interpolation,
same glTF export flags. Removed: the floor-photo twin mesh, wood floor patch, smoke
puffs, paint particles, ink splats, occluder, texture-switch bones. The artwork side is
the character PNG itself; sides/back take the PNG's representative edge colour.

Run: blender -b -noaudio --python build_plate.py -- --jobdir DIR --out FILE.glb \
        [--name NAME] [--motion bounce|sway|still] [--height 0.578]
Motion is a simple in-place hop loop (bounce): squash on landing, stretch at the top.
"""
import bpy, json, math, os, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
JOBDIR = arg('--jobdir')
OUT = arg('--out')
NAME = arg('--name', 'plate')
MOTION = arg('--motion', 'bounce')
FIG_H = float(arg('--height', '0.578'))
THICK = 0.040 / 0.600 * FIG_H
FPS = 30

# ---------- easing + timeline sampling (verbatim from in-house build) ----------
def easeInOutSine(t): return -(math.cos(math.pi * t) - 1) / 2
def easeInOutQuad(t): return 2 * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 2 / 2
def easeOutQuad(t): return 1 - (1 - t) * (1 - t)
def easeInQuad(t): return t * t
def easeInCubic(t): return t ** 3
def easeOutBack(t, s=1.70158): return 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2
def hold(t): return 1.0 if t >= 1 else 0.0
EASE = {k: v for k, v in globals().items() if k.startswith('ease') or k == 'hold'}

def sample(keys, t):
    if t <= keys[0]['t']: k = keys[0]; return {c: k[c] for c in ('rotX', 'posZ', 's', 'rotZ', 'core', 'feet', 'legs', 'belly', 'head', 'posX', 'posY', 'legSwing')}
    for i in range(1, len(keys)):
        a, b = keys[i - 1], keys[i]
        if t <= b['t']:
            u = (t - a['t']) / (b['t'] - a['t']) if b['t'] > a['t'] else 1
            e = EASE[b['ease']](u); es = EASE[b.get('easeScale', b['ease'])](u)
            lerp = lambda x, y, f: x + (y - x) * f
            d = dict(rotX=lerp(a['rotX'], b['rotX'], e), posZ=lerp(a['posZ'], b['posZ'], e),
                     s=[lerp(a['s'][j], b['s'][j], es) for j in range(3)], rotZ=lerp(a['rotZ'], b['rotZ'], e))
            for c in ('core', 'feet', 'legs', 'belly', 'head', 'posX', 'posY', 'legSwing'): d[c] = lerp(a[c], b[c], e)
            return d
    k = keys[-1]; return {c: k[c] for c in ('rotX', 'posZ', 's', 'rotZ', 'core', 'feet', 'legs', 'belly', 'head', 'posX', 'posY', 'legSwing')}

def key(t, feet=1.0, belly=1.0, head=1.0, posZ=0.0, rotZ=0.0, ease='easeInOutSine', rotX=90.0, legSwing=0.0, posX=0.0):
    return dict(t=t, rotX=rotX, posZ=posZ, s=[1.0, 1.0, 1.0], rotZ=rotZ, core=0.0,
                feet=feet, legs=0.5, belly=belly, head=head, posX=posX, posY=0.0, ease=ease, legSwing=legSwing)

def make_clips():
    """Named emotion/motion clips (names are a contract with the player):
    idle / happy / surprised / sad / angry / talk / dangle / land / zap.
    idle MUST stay first: the publish overlay plays animIndex 0 by default.
    Key schema matches in-house: feet/belly/head are bone Y-scales (X/Z get
    1/sqrt), posZ is hop height in FIG_H units, rotZ is yaw degrees,
    rotX 90 = upright (lower pitches forward), legSwing pitches the legs bone."""
    idle = ([
        key(0.00, feet=0.94, belly=0.96, head=0.98, posZ=0.000),
        key(0.60, feet=0.90, belly=0.93, head=0.96, posZ=0.000, ease='easeInOutSine'),
        key(1.10, feet=1.05, belly=1.03, head=1.01, posZ=0.055, ease='easeOutQuad'),
        key(1.55, feet=1.02, belly=1.01, head=1.00, posZ=0.028),
        key(1.95, feet=0.97, belly=0.98, head=0.99, posZ=0.000, ease='easeInOutSine'),
        key(2.40, feet=0.94, belly=0.96, head=0.98, posZ=0.000),
    ], 2.4)
    happy = ([
        key(0.00, feet=0.94, belly=0.96, head=0.98, posZ=0.000),
        key(0.18, feet=0.76, belly=0.84, head=0.92, posZ=0.000, ease='easeInQuad'),
        key(0.95, feet=1.13, belly=1.09, head=1.04, posZ=0.300, rotZ=360.0, ease='easeOutQuad'),
        key(1.25, feet=0.98, belly=0.99, head=1.00, posZ=0.020, rotZ=360.0, ease='easeInQuad'),
        key(1.45, feet=0.82, belly=0.88, head=0.94, posZ=0.000, rotZ=360.0, ease='easeOutQuad'),
        key(1.60, feet=0.94, belly=0.96, head=0.98, posZ=0.000, rotZ=360.0),
    ], 1.6)
    surprised = ([
        key(0.00, feet=0.94, belly=0.96, head=0.98, posZ=0.000),
        key(0.10, feet=1.24, belly=1.19, head=1.11, posZ=0.055, ease='easeOutQuad'),
        key(0.75, feet=1.22, belly=1.17, head=1.10, posZ=0.050),
        key(1.30, feet=0.94, belly=0.96, head=0.98, posZ=0.000, ease='easeInOutSine'),
    ], 1.3)
    sad = ([
        key(0.00, feet=0.94, belly=0.96, head=0.98, posZ=0.000),
        key(0.90, feet=0.80, belly=0.85, head=0.91, posZ=-0.012, rotX=103.0, ease='easeInOutSine'),
        key(1.80, feet=0.79, belly=0.84, head=0.90, posZ=-0.012, rotX=104.0),
    ], 1.8)
    angry_keys = [key(0.00, feet=0.92, belly=0.95, head=0.97, posZ=0.000)]
    tt = 0.12
    flip = 1
    while tt < 1.02:
        angry_keys.append(key(round(tt, 3), feet=0.88 if flip > 0 else 1.03, belly=0.92 if flip > 0 else 1.01,
                              head=0.95 if flip > 0 else 1.0, posZ=0.030 if tt in (0.48, 0.96) else 0.004,
                              posX=0.010 * flip, ease='easeInOutQuad'))
        flip = -flip; tt += 0.12
    angry_keys.append(key(1.20, feet=0.80, belly=0.87, head=0.93, posZ=0.000, ease='easeOutQuad'))
    angry_keys.append(key(1.50, feet=0.92, belly=0.95, head=0.97, posZ=0.000))
    angry = (angry_keys, 1.5)
    talk = ([
        key(0.00, feet=0.96, belly=0.97, head=0.99, posZ=0.006),
        key(0.20, feet=1.01, belly=1.00, head=1.00, posZ=0.016, ease='easeInOutSine'),
        key(0.40, feet=0.96, belly=0.97, head=0.99, posZ=0.006, ease='easeInOutSine'),
        key(0.60, feet=1.01, belly=1.00, head=1.00, posZ=0.016, ease='easeInOutSine'),
        key(0.80, feet=0.96, belly=0.97, head=0.99, posZ=0.006, ease='easeInOutSine'),
        key(1.00, feet=1.01, belly=1.00, head=1.00, posZ=0.016, ease='easeInOutSine'),
        key(1.20, feet=0.96, belly=0.97, head=0.99, posZ=0.006, ease='easeInOutSine'),
        key(1.40, feet=1.00, belly=0.99, head=1.00, posZ=0.012, ease='easeInOutSine'),
        key(1.60, feet=0.96, belly=0.97, head=0.99, posZ=0.006),
    ], 1.6)
    dangle = ([
        key(0.00, feet=1.02, belly=1.01, head=1.00, posZ=0.000, rotZ=-5.0, legSwing=22.0),
        key(0.40, feet=1.02, belly=1.01, head=1.00, posZ=0.000, rotZ=0.0, legSwing=-22.0, ease='easeInOutSine'),
        key(0.80, feet=1.02, belly=1.01, head=1.00, posZ=0.000, rotZ=5.0, legSwing=22.0, ease='easeInOutSine'),
        key(1.20, feet=1.02, belly=1.01, head=1.00, posZ=0.000, rotZ=0.0, legSwing=-22.0, ease='easeInOutSine'),
        key(1.60, feet=1.02, belly=1.01, head=1.00, posZ=0.000, rotZ=-5.0, legSwing=22.0, ease='easeInOutSine'),
    ], 1.6)
    land = ([
        key(0.00, feet=0.64, belly=0.72, head=0.82, posZ=0.000),
        key(0.22, feet=1.10, belly=1.06, head=1.02, posZ=0.018, ease='easeOutQuad'),
        key(0.45, feet=0.90, belly=0.93, head=0.97, posZ=0.000, ease='easeInOutSine'),
        key(0.80, feet=0.94, belly=0.96, head=0.98, posZ=0.000),
    ], 0.8)
    zap_keys = [key(0.00, feet=0.96, belly=0.97, head=0.99, posZ=0.004, rotZ=0.0)]
    tt = 0.06; flip = 1
    while tt < 0.86:
        zap_keys.append(key(round(tt, 3), feet=0.93 if flip > 0 else 1.05, belly=0.95 if flip > 0 else 1.03,
                            head=0.97 if flip > 0 else 1.01, posZ=0.010, rotZ=3.5 * flip, ease='hold'))
        flip = -flip; tt += 0.06
    zap_keys.append(key(1.00, feet=0.94, belly=0.96, head=0.98, posZ=0.000, rotZ=0.0, ease='easeInOutSine'))
    zap = (zap_keys, 1.0)
    return {'idle': idle, 'happy': happy, 'surprised': surprised, 'sad': sad,
            'angry': angry, 'talk': talk, 'dangle': dangle, 'land': land, 'zap': zap}

CLIPS = make_clips()

# ---------- scene reset ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
scene.frame_start = 0; scene.frame_end = int(CLIPS['idle'][1] * FPS)

# ---------- import plate (from mesh_from_mask.py) ----------
bpy.ops.wm.ply_import(filepath=os.path.join(JOBDIR, 'plate.ply'))
ob = bpy.context.view_layer.objects.active
ob.name = NAME; me = ob.data
import bmesh
bm = bmesh.new(); bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bm.to_mesh(me); bm.free(); me.update()
bv = ob.modifiers.new('rim', 'BEVEL'); bv.width = THICK * 0.22; bv.segments = 6; bv.profile = 0.5
bv.limit_method = 'ANGLE'; bv.angle_limit = math.radians(60); bv.use_clamp_overlap = True; bv.harden_normals = False
bpy.ops.object.modifier_apply(modifier='rim')
try:
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
except Exception as e:
    print('shade_smooth_by_angle failed', e); bpy.ops.object.shade_smooth()
ob.location = (0, 0, 0)

# ---------- materials: artwork front / solid edge+back ----------
def srgb_to_lin(c): return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
edge_rgb = json.load(open(os.path.join(JOBDIR, 'edge_color.json')))['rgb_srgb']
edge_lin = tuple(srgb_to_lin(c) for c in edge_rgb) + (1.0,)

photo = bpy.data.materials.new('Artwork'); photo.use_nodes = True
pb = photo.node_tree.nodes['Principled BSDF']
tex = photo.node_tree.nodes.new('ShaderNodeTexImage')
tex.image = bpy.data.images.load(os.path.join(JOBDIR, 'texture.png'))
photo.node_tree.links.new(tex.outputs['Color'], pb.inputs['Base Color'])
photo.node_tree.links.new(tex.outputs['Alpha'], pb.inputs['Alpha'])
photo.node_tree.links.new(tex.outputs['Color'], pb.inputs['Emission Color'])
pb.inputs['Emission Strength'].default_value = 0.5
pb.inputs['Roughness'].default_value = 0.5; pb.inputs['Specular IOR Level'].default_value = 0.3
# Alpha Clip: the glTF must carry alphaMode=MASK so the player keeps the art
# face in the opaque pass with depth writes (BLEND caused draw-order artifacts
# where the far edge rendered over the art). Post-export fix_alpha.py enforces
# the same on the shipped GLB regardless of exporter mapping.
for _prop, _val in (('surface_render_method', 'OPAQUE'), ('blend_method', 'CLIP'), ('alpha_threshold', 0.5)):
    try: setattr(photo, _prop, _val)
    except Exception: pass

edge = bpy.data.materials.new('EdgeSolid'); edge.use_nodes = True
eb = edge.node_tree.nodes['Principled BSDF']
eb.inputs['Base Color'].default_value = edge_lin
eb.inputs['Emission Color'].default_value = edge_lin; eb.inputs['Emission Strength'].default_value = 0.18
eb.inputs['Roughness'].default_value = 0.34; eb.inputs['Metallic'].default_value = 0.0
eb.inputs['Specular IOR Level'].default_value = 0.6
eb.inputs['Coat Weight'].default_value = 0.7; eb.inputs['Coat Roughness'].default_value = 0.25

# UVs straight from plate coordinates (only the front cap samples them, but set on all loops)
xs = [v.co.x for v in me.vertices]; zs = [v.co.z for v in me.vertices]
minx, maxx, minz, maxz = min(xs), max(xs), min(zs), max(zs)
uv = me.uv_layers.new(name='UVMap')
for poly in me.polygons:
    for li in poly.loop_indices:
        v = me.vertices[me.loops[li].vertex_index].co
        uv.data[li].uv = ((v.x - minx) / (maxx - minx), (v.z - minz) / (maxz - minz))
me.materials.clear(); me.materials.append(photo); me.materials.append(edge)
me.update()
n_photo = 0
for poly in me.polygons:
    poly.material_index = 0 if poly.normal.y < -0.7 else 1     # front cap (-Y) = artwork; walls + back cap = solid
    n_photo += (poly.material_index == 0)
print(f'materials: {n_photo}/{len(me.polygons)} polys artwork, rest solid edge {edge_rgb}')

# ---------- root + rig: legs -> belly -> head (in-house proportions/weights) ----------
root = bpy.data.objects.new(f'{NAME}_root', None); scene.collection.objects.link(root); root.location = (0, 0, 0)
arm_data = bpy.data.armatures.new(f'{NAME}_rig'); arm = bpy.data.objects.new(f'{NAME}_rig', arm_data)
scene.collection.objects.link(arm); arm.parent = root
bpy.context.view_layer.objects.active = arm; arm.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
def mkbone(nm, head, tail, parent=None, connect=False):
    b = arm_data.edit_bones.new(nm); b.head = head; b.tail = tail
    if parent: b.parent = arm_data.edit_bones[parent]; b.use_connect = connect
    return b
Z_LEG_TOP, Z_BELLY, Z_HEAD = 0.50 * FIG_H, 0.64 * FIG_H, 1.0 * FIG_H
mkbone('legs', (0, 0, 0.0), (0, 0, Z_LEG_TOP))
mkbone('belly', (0, 0, Z_LEG_TOP), (0, 0, Z_BELLY), 'legs', True)
mkbone('head', (0, 0, Z_BELLY), (0, 0, Z_HEAD), 'belly', True)
bpy.ops.object.mode_set(mode='OBJECT')

def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)
vg = {n: ob.vertex_groups.new(name=n) for n in ('legs', 'belly', 'head')}
J = 0.012 * FIG_H
for v in me.vertices:
    x, y, z = v.co
    s_hip = smoothstep(Z_LEG_TOP - 1.6 * J, Z_LEG_TOP + 1.6 * J, z)
    wh = smoothstep(0.55 * FIG_H, 0.75 * FIG_H, z)
    wb = max(0.0, s_hip - wh)
    for nme, w in (('legs', 1.0 - s_hip), ('belly', wb), ('head', wh)):
        if w > 1e-4: vg[nme].add([v.index], w, 'REPLACE')
ob.parent = arm; ob.parent_type = 'OBJECT'
md = ob.modifiers.new('rig', 'ARMATURE'); md.object = arm
ob.matrix_parent_inverse.identity()

# ---------- bake every clip into its own action, LINEAR (in-house recipe) ----------
arm.rotation_mode = 'XYZ'
for bn in ('legs', 'belly', 'head'):
    arm.pose.bones[bn].rotation_mode = 'XYZ'
pbones = arm.pose.bones
if arm.animation_data is None:
    arm.animation_data_create()
for clip_name, (keys, dur) in CLIPS.items():
    act = bpy.data.actions.new(clip_name)
    arm.animation_data.action = act
    scene.frame_start = 0; scene.frame_end = int(dur * FPS)
    for f in range(0, int(dur * FPS) + 1):
        t = f / FPS
        v = sample(keys, t)
        arm.rotation_euler = (math.radians(v['rotX'] - 90), 0, math.radians(v['rotZ']))
        arm.location = (v['posX'] * FIG_H, v['posY'] * FIG_H, v['posZ'] * FIG_H)
        arm.scale = tuple(v['s'])
        arm.keyframe_insert('rotation_euler', frame=f); arm.keyframe_insert('location', frame=f); arm.keyframe_insert('scale', frame=f)
        for bn in ('legs', 'belly', 'head'):
            sy = v[bn]; sx = 1.0 / math.sqrt(sy)
            pbones[bn].scale = (sx, sy, sx); pbones[bn].keyframe_insert('scale', frame=f)
        pbones['legs'].rotation_euler = (math.radians(v['legSwing']), 0, 0)
        pbones['legs'].keyframe_insert('rotation_euler', frame=f)
    for fc in act.fcurves:
        for kp in fc.keyframe_points: kp.interpolation = 'LINEAR'
    act.name = clip_name
    # Stash into an NLA track too so ACTIONS/NLA exporters both see every clip.
    track = arm.animation_data.nla_tracks.new()
    track.name = clip_name
    strip = track.strips.new(clip_name, 0, act)
    strip.extrapolation = 'NOTHING'
arm.animation_data.action = bpy.data.actions['idle']

# ---------- baked ground blob shadow ----------
# A soft radial-gradient disc lying on the ground, parented to the root (NOT the
# armature) so it stays planted while the character hops. Baked into the GLB
# because the project-side decal overlay did not render in the player/emulator;
# geometry inside the model renders wherever the model renders.
import numpy as _np
_S = 256
_yy, _xx = _np.mgrid[0:_S, 0:_S]
_r = _np.sqrt(((_xx - _S / 2) / (_S / 2)) ** 2 + ((_yy - _S / 2) / (_S / 2)) ** 2)
_a = _np.clip(1.0 - _r, 0.0, 1.0) ** 2 * 0.62
_bimg = bpy.data.images.new('blob_shadow', _S, _S, alpha=True)
_px = _np.zeros((_S, _S, 4), dtype=_np.float32)
_px[:, :, 3] = _a[::-1]
_bimg.pixels.foreach_set(_px.ravel())
_bmat = bpy.data.materials.new('BlobShadow'); _bmat.use_nodes = True
_bp = _bmat.node_tree.nodes['Principled BSDF']
_bp.inputs['Base Color'].default_value = (0.0, 0.0, 0.0, 1.0)
_bp.inputs['Roughness'].default_value = 1.0
_btex = _bmat.node_tree.nodes.new('ShaderNodeTexImage'); _btex.image = _bimg
_bmat.node_tree.links.new(_btex.outputs['Alpha'], _bp.inputs['Alpha'])
try: _bmat.surface_render_method = 'BLENDED'
except Exception: pass
_bw = FIG_H * 1.09  # plate width is FIG_H*aspect(0.75); blob = 1.45x that
bpy.ops.mesh.primitive_plane_add(size=_bw, location=(0.0, 0.0, 0.003))
blob = bpy.context.active_object; blob.name = 'BlobShadow'
blob.data.materials.append(_bmat)
blob.parent = root

# ---------- export GLB (in-house flags) ----------
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.object.select_all(action='DESELECT')
for o in (root, arm, ob, blob): o.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True,
    export_animations=True, export_animation_mode='ACTIONS', export_anim_scene_split_object=False,
    export_force_sampling=True, export_frame_step=1,
    export_apply=True, export_yup=True, export_materials='EXPORT')
print('GLB written', OUT, os.path.getsize(OUT))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(JOBDIR, f'{NAME}.blend'))
print('DONE polys', len(me.polygons), 'verts', len(me.vertices), 'bones 3, clips', list(CLIPS))
