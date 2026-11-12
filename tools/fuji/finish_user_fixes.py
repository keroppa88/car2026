"""base_landcover_1357.png に、そのあとの絵の指示(later_overrides.png: 2 草地、3 アスファルト)を重ねて map/fuji-landcover.png にする。
二股の近道のわきにはみ出していた路面の色(白線の外)は、となりの色にする(指示: コースの色のはみ出しをなくす)。"""
import json
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]; P = ROOT / 'tools/fuji/paint'
d = json.loads((ROOT / 'map/fuji-course.json').read_text()); L = d['landcover']
img = cv2.imread(str(P / 'base_landcover_1357.png')); H, W = img.shape[:2]
src = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text(); col = lambda k: tuple(int(q) for q in src.split(f"'{k}': (")[1].split(')')[0].split(','))
ROAD = np.array((75, 73, 71), np.uint8)
road = (img == ROAD).all(2)
br = np.zeros((H, W), np.uint8)
for b in d['branches']:
    if b['w'] > 9: cv2.polylines(br, [np.round(np.array(b['pts']) - [L['x0'], L['z0']]).astype(np.int32)], False, 1, 1)
db = cv2.distanceTransform(1 - br, cv2.DIST_L2, 5)
spill = road & (db < 25) & (db > 6.8)
_, (iy, ix) = ndimage.distance_transform_edt(road, return_indices=True); img[spill] = img[iy, ix][spill]
print('近道わきの路面の色のはみ出し', int(spill.sum()), 'm2')
lo = cv2.imread(str(P / 'later_overrides.png'), 0)
img[lo == 2] = col('grass'); img[lo == 3] = col('paved')
cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), img)
cv2.imwrite(str(P / 'final_overrides.png'), lo)
print('あとの指示 草地', int((lo == 2).sum()), ' アスファルト', int((lo == 3).sum()), 'm2')
