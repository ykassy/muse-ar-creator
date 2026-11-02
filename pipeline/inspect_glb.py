"""inspect_glb.py - structural summary of a GLB (pure stdlib): meshes, skins/joints, animations."""
import json, struct, sys, os

def inspect(path):
    d = open(path, 'rb').read()
    assert d[:4] == b'glTF', 'not a GLB'
    jlen, jtype = struct.unpack('<II', d[12:20])
    assert jtype == 0x4E4F534A, 'first chunk is not JSON'
    g = json.loads(d[20:20 + jlen])
    out = {'file': os.path.basename(path), 'bytes': len(d),
           'meshes': len(g.get('meshes', [])), 'nodes': len(g.get('nodes', [])),
           'images': len(g.get('images', [])), 'materials': [m.get('name') for m in g.get('materials', [])],
           'skins': [{'joints': len(s.get('joints', [])),
                      'names': [g['nodes'][j].get('name') for j in s.get('joints', [])]} for s in g.get('skins', [])],
           'animations': []}
    for a in g.get('animations', []):
        dur = 0.0
        for s in a.get('samplers', []):
            acc = g['accessors'][s['input']]
            if acc.get('max'): dur = max(dur, acc['max'][0])
        out['animations'].append({'name': a.get('name'), 'channels': len(a.get('channels', [])), 'duration_s': round(dur, 3)})
    return out

if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False, indent=1))
