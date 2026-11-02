import struct, json, sys

# Force alphaMode=MASK (+alphaCutoff) on textured materials in a GLB, in place.
path = sys.argv[1]
data = bytearray(open(path, 'rb').read())
assert data[:4] == b'glTF'
clen, ctype = struct.unpack('<II', data[12:20])
gltf = json.loads(bytes(data[20:20+clen]))
changed = []
for m in gltf.get('materials', []):
    pbr = m.get('pbrMetallicRoughness', {})
    if 'baseColorTexture' in pbr and m.get('name') == 'Artwork':
        # The texture is fully opaque (transparent area flooded with the edge
        # colour in prep_mask), so the artwork ships OPAQUE: no alphaTest, no
        # cutout holes at the rim, depth writes on.
        m.pop('alphaMode', None)
        m.pop('alphaCutoff', None)
        changed.append(m.get('name'))
# The default clip (animIndex 0 in the player) must be 'idle': the exporter
# emits animations alphabetically, so move idle to the front. Whole animation
# objects are self-contained (channels/samplers index within the object), so
# reordering the array is safe.
anims = gltf.get('animations', [])
if anims:
    gltf['animations'] = sorted(anims, key=lambda a: 0 if a.get('name') == 'idle' else 1)
js = json.dumps(gltf, separators=(',', ':')).encode()
js += b' ' * (-len(js) % 4)
out = bytearray()
out += data[:12]
out += struct.pack('<II', len(js), 0x4E4F534A)
out += js
rest = 20 + clen
if rest < len(data):
    blen, btype = struct.unpack('<II', data[rest:rest+8])
    out += data[rest:rest+8+blen]
struct.pack_into('<I', out, 8, len(out))
open(path, 'wb').write(bytes(out))
print('Artwork forced OPAQUE:', changed)
