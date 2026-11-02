"""run_glb.py - pipeline driver: transparent PNG -> semi-3D plate GLB (+ previews).

  .venv/bin/python src/run_glb.py --input art.png --name bonfire [--motion bounce|sway|still] [--height 0.578]

Stages: prep_mask (alpha silhouette) -> mesh_from_mask (watertight plate PLY, in-house backbone)
-> build_plate (Blender: artwork front / solid sides, 3-bone squash&stretch rig, baked GLB)
-> inspect_glb -> render_preview (front/side/back stills).
"""
import argparse, os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLENDER = os.path.join(ROOT, 'blender', 'blender')
PY = os.path.join(ROOT, '.venv', 'bin', 'python')

def run(cmd, env=None, cwd=None):
    print('+', ' '.join(cmd), flush=True)
    r = subprocess.run(cmd, env=env, cwd=cwd)
    if r.returncode != 0:
        raise SystemExit(f'FAILED ({r.returncode}): {" ".join(cmd)}')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--motion', default='bounce', choices=['bounce', 'sway', 'still'])
    ap.add_argument('--height', default='0.578')
    a = ap.parse_args()

    jobdir = os.path.join(ROOT, 'work', a.name)
    os.makedirs(jobdir, exist_ok=True)
    out_glb = os.path.join(ROOT, 'out', f'{a.name}.glb')
    prevdir = os.path.join(ROOT, 'previews')
    os.makedirs(os.path.dirname(out_glb), exist_ok=True); os.makedirs(prevdir, exist_ok=True)

    run([PY, os.path.join(ROOT, 'src', 'prep_mask.py'), os.path.abspath(a.input), jobdir])
    shutil.copyfile(os.path.join(ROOT, 'src', 'mesh_from_mask.py'), os.path.join(jobdir, 'mesh_from_mask.py'))
    env = dict(os.environ, PLATE_FIG_H=a.height, PLATE_PLY='plate.ply')
    run([PY, os.path.join(jobdir, 'mesh_from_mask.py')], env=env, cwd=jobdir)
    run([BLENDER, '-b', '-noaudio', '--python', os.path.join(ROOT, 'src', 'build_plate.py'), '--',
         '--jobdir', jobdir, '--out', out_glb, '--name', a.name, '--motion', a.motion, '--height', a.height])
    run([PY, os.path.join(ROOT, 'src', 'fix_alpha.py'), out_glb])
    run([PY, os.path.join(ROOT, 'src', 'inspect_glb.py'), out_glb])
    run([BLENDER, '-b', '-noaudio', '--python', os.path.join(ROOT, 'src', 'render_preview.py'), '--',
         '--glb', out_glb, '--outdir', prevdir, '--name', a.name])
    print('PIPELINE DONE ->', out_glb)

if __name__ == '__main__':
    main()
