# 東京駅〜日本橋の地図(SimLab の GLB)をゲーム用に整える。
#  - 元の GLB はルートの行列で横倒し・インチ換算(0.0254倍)になっているので外し、1単位=1m・Y が上にする。
#  - 元の座標はそのままで北が -z(日本橋川が北、東京駅が西)。反転はしない。
# 使い方: python3 tools/prep_tokyoeki.py 元.glb tools/tokyoeki_src.glb map/map_tokyoeki.glb
#  - tools/tokyoeki_src.glb: 建物も含む全部(tools/tokyoeki_city.py の入力)
#  - map/map_tokyoeki.glb: ゲーム用。地面・路面・線路・川・緑だけ(建物は three.js で描き、当たり判定も自前)
import json, struct, sys
import numpy as np

src, dst, game = sys.argv[1], sys.argv[2], sys.argv[3]
d = open(src, 'rb').read()
clen = struct.unpack('<I', d[12:16])[0]
j = json.loads(d[20:20 + clen])
boff = 20 + clen
blen = struct.unpack('<I', d[boff:boff + 4])[0]
B = bytearray(d[boff + 8:boff + 8 + blen])

def view(ai):
    a = j['accessors'][ai]; bv = j['bufferViews'][a['bufferView']]
    comp = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[a['componentType']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    assert not bv.get('byteStride') or bv['byteStride'] == n * np.dtype(comp).itemsize
    return np.frombuffer(B, dtype=comp, count=a['count'] * n, offset=off).reshape(a['count'], n)

# 変換は全部外す(メッシュの座標がそのまま m)
for n in j['nodes']:
    for k in ('matrix', 'rotation', 'scale', 'translation'): n.pop(k, None)
# カメラ用の空ノード(Active View)は残しても害はないが、名前で分かるようにする
js = json.dumps(j, separators=(',', ':')).encode()
js += b' ' * ((4 - len(js) % 4) % 4)
out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(B))
out += struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(B), b'BIN\x00') + bytes(B)
open(dst, 'wb').write(out)
# ゲーム用: 地面などの材質のメッシュだけ残す
GROUND = {'M06_Steel_Smoke', 'M05_Graphite_Haze', 'Asphalt_06_1K', 'F08_Forest_Shadow', 'H06_Ocean_Depth', 'H07_Deep_Teal'}
for n in j['nodes']:
    mi = n.get('mesh')
    if mi is None: continue
    names = {j['materials'][p.get('material', 0)]['name'] for p in j['meshes'][mi]['primitives']}
    if not names & GROUND: n.pop('mesh')
js = json.dumps(j, separators=(',', ':')).encode()
js += b' ' * ((4 - len(js) % 4) % 4)
out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(B))
out += struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(B), b'BIN\x00') + bytes(B)
open(game, 'wb').write(out)
print('ok', len(out))
