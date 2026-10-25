# 選んだ PLATEAU の建物を three.js 用の三角形にする → map/nihonbashi-landmarks.json
# 座標は街のデータ(osm_to_city.py)と同じ: 範囲の中心が原点、x=東、z=南、y=高さ(m)
# 建物データ: 3D都市モデル(Project PLATEAU) 国土交通省
import json, math, pickle, sys
import numpy as np, mapbox_earcut as earcut
from shapely.geometry import Polygon
from shapely.ops import unary_union
area = json.load(open('/home/claude/car2026/tools/tokyo-center-area.json'))['lonlat']
lat0 = (min(p[1] for p in area) + max(p[1] for p in area)) / 2
lon0 = (min(p[0] for p in area) + max(p[0] for p in area)) / 2
KX, KZ = math.cos(math.radians(lat0)) * 111320.0, 110574.0
def xz(la, lo): return ((lo - lon0) * KX, -(la - lat0) * KZ)
# PLATEAU が完成前の古い姿・位置が不確かなものは OSM の建物のままにする
SKIP = {'日本橋野村ビルディング', 'TOFROM YAESU', '東京ミッドタウン日本橋', 'Ginza Sony Park'}
# 色と窓の模様(実際の外観に似せる)。style は osm-city.js の STYLES の番号:
#   0 帯窓  1 四角い窓  2 ガラス張り  3 住宅  4 縦長の細い窓  5 石の格子  6 戦前の石造り  7 ガラス+縦ルーバー
B, P, C, S, G, K, F = 0, 1, 2, 4, 5, 6, 7
def c(color, style, roof=None):
    d = {'color': color, 'style': style}
    if roof: d['roofColor'] = roof
    return d
COLOR = {
    '東京駅 丸の内駅舎': c('#9c4a32', P, '#3a4150'),
    '新大手町ビル': c('#cfc8b6', B),
    '丸の内オアゾ': c('#8fa3b3', C),
    'Otemachi One': c('#c9cdd1', F),
    '読売新聞ビル': c('#d2d1cc', G),
    '大手町フィナンシャルシティ グランキューブ': c('#a7b8c5', C),
    '大手町フィナンシャルシティ サウスタワー': c('#cbc2b0', G),
    '大手町フィナンシャルシティ ノースタワー': c('#cdc5b4', G),
    '東京サンケイビル': c('#6f7f8c', C),
    '大手町ビル': c('#c9bda6', B),
    '大手町ファーストスクエア': c('#d6d6d2', G),
    '大手町タワー': c('#5f7182', C),
    '東京消防庁本部庁舎': c('#b9b6ae', P),
    'みずほ丸の内タワー': c('#8ea2b0', C),
    '三井住友銀行本店東館': c('#9fb2c0', C),
    '新丸ビル': c('#a6b5bf', C),
    '丸の内永楽ビル': c('#d3cbbd', G),
    '日本工業倶楽部会館・三菱UFJ信託銀行本店ビル': c('#c9bea8', G),
    '三井住友銀行本店ビル': c('#c8b89a', G),
    '丸ビル': c('#cdbfa5', G),
    '丸の内二丁目ビル': c('#b8a88f', P),
    '三菱ビル': c('#b5b3ad', B),
    '三菱商事ビル': c('#cbbfa8', G),
    '郵船ビル': c('#c7b9a0', G),
    '丸の内仲通りビル': c('#bdbab2', B),
    '明治安田生命ビル': c('#cfc4ad', G),
    '三菱一号館美術館': c('#9a4b35', K, '#3e4148'),
    '新東京ビル': c('#b0aea8', B),
    'ザ・ペニンシュラ東京': c('#b49a78', P),
    '帝国ホテル東京': c('#d8d0bf', P),
    '東京ミッドタウン日比谷': c('#9fb3c2', C),
    '有楽町電気ビル': c('#7a5c4c', B),
    '有楽町マリオン': c('#b9c3c9', C),
    '東京交通会館': c('#d9d4c8', B),
    '読売会館': c('#c6bfb1', B),
    '銀座三越': c('#dcd8cf', G),
    '松屋銀座': c('#e6e3dc', G),
    '和光本館': c('#b9ad98', K, '#5d6460'),
    '銀座クリスタルビル': c('#b6c2ca', C),
    'ヒューリック銀座数寄屋橋ビル': c('#c9c2b5', G),
    'V88ビルディング': c('#c2a878', S),
    '東京建物八重洲ビル': c('#bdbbb5', G),
    '東京ミッドタウン八重洲': c('#9db0be', C),
    '築地本願寺': c('#d2c3a3', K, '#a69a85'),
    '歌舞伎座タワー': c('#c2c9cd', C),
    '東京日本橋タワー': c('#8ca1b0', C),
    '日本橋高島屋 本館': {**c('#c4a46c', K, '#8a8478'), 'awning': 1},   # 黄土色の石造り、1階は赤い日よけ
    '日本橋高島屋三井ビルディング': c('#8ea1ad', C),
    '日本橋ダイヤビルディング': c('#b9ad9a', G),
    '日本橋郵便局': c('#b4b2ad', P),
    '中央警察署日本橋交番': c('#a8a49c', P),
    '日本橋三越本店': c('#d8ccb2', K, '#8a8a80'),
    '日本銀行本店本館': c('#b8b3a6', K, '#5f8a7a'),
    '三井本館': c('#cbbd9e', K),
    '日本橋室町三井タワー': c('#8fa2b1', C),
    'コレド室町1': c('#c9b99c', G),
    'コレド室町2': c('#c4b6a0', G),
    'コレド室町3': c('#c8bba4', G),
    'コレド日本橋': c('#9eb0bd', C),
    'KABUTO ONE': c('#b7c3ca', C),
    '東京証券取引所': c('#a99a86', P),
    '日証館': c('#b39478', K),
    'パシフィックセンチュリープレイス丸の内': c('#96aabb', C),
    '首都高速道路 鍛冶橋換気所': c('#a8a8a4', P),
    '東京国際フォーラム': c('#c5d0d6', C),
    '日本橋日枝神社': c('#8a5a3c', P, '#3f4a45'),
    '茅場町タワー': c('#b8ab98', G),
}
SEL = pickle.load(open('/home/claude/plateau/selected.pkl', 'rb'))

def tri(poly, y0, out, uv=None):  # uv は使わない(窓の模様は JS 側で面の向きから計算)
    ext, ints = poly
    rings = [ext] + ints
    P = []
    for r in rings:
        r = r[:-1] if len(r) > 1 and r[0] == r[-1] else r
        P.append([(*xz(p[0], p[1]), p[2] - y0) for p in r])
    pts = np.array([q for r in P for q in r], dtype=float)
    if len(pts) < 3: return
    xyz = pts[:, [0, 2, 1]]   # (x, y=高さ, z)
    # 面の向き(Newell)
    n = np.zeros(3)
    for i in range(len(P[0])):
        a, b = np.array(xyz[i]), np.array(xyz[(i + 1) % len(P[0])])
        n += [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]
    if np.linalg.norm(n) < 1e-9: return
    n /= np.linalg.norm(n)
    k = int(np.argmax(np.abs(n)))
    ax = [i for i in range(3) if i != k]
    v2 = xyz[:, ax]
    ends = np.cumsum([len(r) for r in P]).astype(np.uint32)
    try: idx = earcut.triangulate_float64(v2, ends)
    except Exception: return
    for t in range(0, len(idx), 3):
        a, b, c = xyz[idx[t]], xyz[idx[t + 1]], xyz[idx[t + 2]]
        # 法線の向きにそろえる
        if np.dot(np.cross(b - a, c - a), n) < 0: b, c = c, b
        for p in (a, b, c):
            out.extend(round(float(v), 1) for v in p)

res = []
for s in SEL:
    if not s['parts'] or s['label'] in SKIP: continue
    y0 = min(min(p[2] for p in b['fp']) for b in s['parts'])
    zs = [p[2] for b in s['parts'] for w in b['walls'] for p in w[0]]
    if zs: y0 = min(zs)
    walls, uv, roofs = [], [], []
    for b in s['parts']:
        for w in b['walls'] + b['inst']: tri(w, y0, walls)
        for r in b['roofs']: tri(r, y0, roofs)
    fp = unary_union([Polygon([xz(p[0], p[1]) for p in b['fp']]).buffer(0) for b in s['parts']])
    fps = [list(g.exterior.coords) for g in (fp.geoms if hasattr(fp, 'geoms') else [fp]) if g.area > 1]
    if not walls:   # LOD2 が無い建物は外す(普通の建物のまま)
        print('LOD2なし', s['label']); continue
    extra = COLOR.get(s['label'], {})
    res.append({**extra, 'label': s['label'], 'walls': walls, 'roofs': roofs,
                'fp': [[[round(x, 2), round(z, 2)] for x, z in r] for r in fps]})
    print(s['label'], '壁', len(walls) // 9, '屋根', len(roofs) // 9)
json.dump({'source': '3D都市モデル(Project PLATEAU) 国土交通省', 'landmarks': res},
          open(sys.argv[1], 'w'), ensure_ascii=False, separators=(',', ':'))
