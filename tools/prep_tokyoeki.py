# 東京駅〜日本橋の地図(SimLab の GLB)をゲーム用に整える。
#  - 元の GLB はルートの行列で横倒し・インチ換算(0.0254倍)になっているので外し、1単位=1m・Y が上にする。
#  - 元の座標はそのままだと鏡像(東京駅が東側)になるので z を反転する(面の向きも裏返す)。
# 使い方: python3 tools/prep_tokyoeki.py 元.glb map/map_tokyoeki.glb
import json, struct, sys
import numpy as np

src, dst = sys.argv[1], sys.argv[2]
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

done = set()
for m in j['meshes']:
    for p in m['primitives']:
        for key in ('POSITION', 'NORMAL'):
            ai = p['attributes'].get(key)
            if ai is None or ai in done: continue
            done.add(ai)
            v = view(ai); v[:, 2] *= -1
            a = j['accessors'][ai]
            if 'min' in a:
                mn, mx = a['min'][2], a['max'][2]; a['min'][2], a['max'][2] = -mx, -mn
        ii = p.get('indices')
        if ii is not None and ii not in done:
            done.add(ii)
            t = view(ii).reshape(-1, 3); t[:, [1, 2]] = t[:, [2, 1]]

# 変換は全部外す(メッシュの座標がそのまま m)
for n in j['nodes']:
    for k in ('matrix', 'rotation', 'scale', 'translation'): n.pop(k, None)
# カメラ用の空ノード(Active View)は残しても害はないが、名前で分かるようにする
js = json.dumps(j, separators=(',', ':')).encode()
js += b' ' * ((4 - len(js) % 4) % 4)
out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(B))
out += struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(B), b'BIN\x00') + bytes(B)
open(dst, 'wb').write(out)
print('ok', len(out))
