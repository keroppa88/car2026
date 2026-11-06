"""富士スピードウェイ: コース後半の二股(ダンロップの近道)を、指示の絵どおり、まっすぐな一本の道にする。
絵の赤い帯: 上の端(-374, 582)付近でコースから分かれ、下の端(-271, 642)付近でコースに戻る。幅は約 13m。"""
import json, math
from pathlib import Path
import numpy as np
F = Path(__file__).resolve().parents[2] / 'map/fuji-course.json'
d = json.loads(F.read_text()); R = np.array([[p[0], p[2]] for p in d['route']])
A, B = np.array([-374.0, 581.6]), np.array([-270.6, 641.7])
j0, j1 = int(np.argmin(((R - A) ** 2).sum(1))), int(np.argmin(((R - B) ** 2).sum(1)))
P0, P1 = R[j0], R[j1]; L = float(np.linalg.norm(P1 - P0)); m = max(2, int(L // 6))
pts = [[round(float(P0[0] + (P1[0] - P0[0]) * k / m), 2), round(float(P0[1] + (P1[1] - P0[1]) * k / m), 2)] for k in range(m + 1)]
d['branches'] = [b for b in d['branches'] if not (b['from'] in range(700, 800) or b['to'] in range(700, 800))]
d['branches'].append({'pts': pts, 'w': 13.0, 'from': j0, 'to': j1})
F.write_text(json.dumps(d, separators=(',', ':')))
print('近道', j0, '→', j1, round(L), 'm')
