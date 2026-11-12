#!/bin/sh
# 富士: 地面の塗り分けを最初から作り直す。 sh tools/fuji/rebuild_landcover.sh 空撮.png 出力フォルダ
set -e
M=$1; O=$2; cd "$(dirname "$0")/../.."
python3 tools/fuji/make_landcover_mosaic.py "$M" "$O" > /dev/null
python3 tools/fuji/apply_area_paint2.py tools/fuji/paint/area_paint2.png "$O" > /dev/null          # 手の直しを作り直し(1枚目)
python3 tools/fuji/apply_area_paint2.py tools/fuji/paint/area_paint3.png "$O" --add --pink-paved > /dev/null
python3 tools/fuji/apply_pitexit_paint.py > /dev/null
python3 tools/fuji/edit_pit_exit.py > /dev/null
python3 tools/fuji/edit_pit_lane.py > /dev/null
python3 tools/fuji/merge_topview.py
python3 tools/fuji/edit_shortcut_island.py > /dev/null
python3 tools/fuji/regularize_course_side.py > /dev/null
python3 tools/fuji/asphalt_rules.py
python3 tools/fuji/edit_shortcut_island.py > /dev/null
python3 tools/fuji/make_trees_cars.py
python3 tools/fuji/smooth_landcover.py
