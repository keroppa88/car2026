"""富士スピードウェイ: 真上ビューの絵の直し(tools/fuji/paint/topview_overrides.png)を、area_overrides.png のいちばん上に重ねる。
apply_pitexit_paint.py・edit_pit_exit.py・edit_pit_lane.py は area_overrides.png を書き直すので、そのあとに実行する。
"""
from pathlib import Path
import cv2
ROOT = Path(__file__).resolve().parents[2]
ovp, tvp = ROOT / 'tools/fuji/paint/area_overrides.png', ROOT / 'tools/fuji/paint/topview_overrides.png'
ov, tv = cv2.imread(str(ovp), 0), cv2.imread(str(tvp), 0)
ov[tv > 0] = tv[tv > 0]; cv2.imwrite(str(ovp), ov); print('真上ビューの直し', int((tv > 0).sum()), 'm2')
