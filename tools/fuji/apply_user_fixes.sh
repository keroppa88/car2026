#!/bin/sh
# 富士: 地面の塗り分け = 11/12 13:57 の地図(paint/base_landcover_1357.png。それまでの指示を反映ずみ)+ そのあとの絵の指示だけ。
# 自動のルール(空撮の読み取り・アスファルトの判定など)はもう使わない。絵の指示を足すときは、この下に 1 行足して実行する。
set -e; cd "$(dirname "$0")/../.."
P=tools/fuji/paint; F=$P/later_overrides.png
python3 -c "import cv2,numpy as np; cv2.imwrite('$F', np.zeros(cv2.imread('$P/base_landcover_1357.png').shape[:2], np.uint8))"
python3 tools/fuji/apply_topview_paint.py $P/fork_paint_reg.png $P/cam_fork.json --red 舗装 --blue なし --out $F      # 二股: 赤 = アスファルト
python3 tools/fuji/apply_topview_paint.py $P/t1_sliver_reg.png $P/cam_t1.json --red 草地 --blue なし --out $F         # 第1コーナー内側: 赤 = 草地
python3 tools/fuji/apply_topview_paint.py $P/t2_paint_reg.png $P/cam_t12.json --red 草地 --blue なし --out $F         # 第2コーナー: 赤 = 草地
python3 tools/fuji/apply_topview_paint.py $P/t12_paint_reg.png $P/cam_t12.json --red 草地 --blue なし --out $F        # 第1・第2コーナー: 赤 = 草地
python3 tools/fuji/apply_topview_paint.py $P/t1_blob_reg.png $P/cam_t12.json --red 草地 --blue なし --out $F         # 第1コーナー外側の灰色: 草地
python3 tools/fuji/apply_topview_paint.py $P/t1_sand_paint.png $P/cam_t12.json --red 草地 --blue なし --out $F       # 第1コーナー外側: 赤 = 草地
python3 tools/fuji/edit_pit_lane.py > /dev/null
python3 tools/fuji/make_fork_lines.py
python3 tools/fuji/finish_user_fixes.py
python3 tools/fuji/make_trees_cars.py
python3 tools/fuji/smooth_landcover.py
