"""render_preview.py - render front/side/back previews of a built GLB with Blender (Cycles CPU).

Renders three views at an airborne frame plus one extra front view at the squash frame.
Views are shot from -Y / +Y / +X of the imported model; whichever horizontal view shows
the artwork is the front - the driver renames using view_map.json written here by bbox:
  view_mY = camera at -Y looking +Y, view_pY = +Y looking -Y, view_pX = +X looking -X.
Run: blender -b -noaudio --python render_preview.py -- --glb FILE --outdir DIR --name NAME [--frame 18] [--squashframe 4]
"""
import bpy, os, sys, json
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
def arg(n, d=None): return argv[argv.index(n) + 1] if n in argv else d
GLB, OUTDIR, NAME = arg('--glb'), arg('--outdir'), arg('--name', 'plate')
FRAME = int(arg('--frame', '18')); SQFRAME = int(arg('--squashframe', '4'))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
scene = bpy.context.scene
scene.render.fps = 30

# world: light grey so the solid edge colour reads against it; sun for shading
w = bpy.data.worlds.new('W'); scene.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.85, 0.85, 0.85, 1)
w.node_tree.nodes['Background'].inputs[1].default_value = 1.0
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3.0; sun.rotation_euler = (0.9, 0.2, 0.4)
scene.collection.objects.link(sun)
fill = bpy.data.objects.new('fill', bpy.data.lights.new('fill', 'AREA'))
fill.data.energy = 300; fill.location = (-2, -2, 2.5); fill.rotation_euler = (0.7, 0, -0.6)
scene.collection.objects.link(fill)

scene.frame_set(FRAME)          # frame the pose that will actually be rendered
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
for o in meshes:
    for c in o.bound_box:
        v = o.matrix_world @ Vector(c); mn = Vector(map(min, mn, v)); mx = Vector(map(max, mx, v))
center = (mn + mx) / 2; size = mx - mn; H = max(size.z, 0.01)
D = H * 1.45
cam_data = bpy.data.cameras.new('cam'); cam_data.lens = 55
cam = bpy.data.objects.new('cam', cam_data); scene.collection.objects.link(cam)
scene.camera = cam
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32; scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x = 640; scene.render.resolution_y = 640
scene.render.image_settings.file_format = 'PNG'

def look(loc):
    cam.location = loc
    cam.rotation_euler = (center - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()

os.makedirs(OUTDIR, exist_ok=True)
views = {'view_mY': center + Vector((0, -D, 0)), 'view_pY': center + Vector((0, D, 0)), 'view_pX': center + Vector((D, 0, 0))}
for vn, loc in views.items():
    look(loc)
    scene.render.filepath = os.path.join(OUTDIR, f'{NAME}_{vn}.png')
    bpy.ops.render.render(write_still=True)
    print('rendered', vn)
# extra: front (-Y) at squash frame
scene.frame_set(SQFRAME)
look(views['view_mY'])
scene.render.filepath = os.path.join(OUTDIR, f'{NAME}_view_mY_squash.png')
bpy.ops.render.render(write_still=True)
json.dump({'bbox_min': list(mn), 'bbox_max': list(mx), 'frame': FRAME, 'squash_frame': SQFRAME},
          open(os.path.join(OUTDIR, f'{NAME}_view_map.json'), 'w'), indent=1)
print('PREVIEW DONE', NAME)
