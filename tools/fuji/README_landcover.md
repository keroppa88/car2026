# 富士: 地面の塗り分けを作り直す順番
空撮(scratchpad の mosaic.png)はリポジトリに入れていない。手で塗った直しは tools/fuji/paint/area_overrides.png に残る。

1. python3 tools/fuji/make_landcover_mosaic.py mosaic.png 出力フォルダ
2. python3 tools/fuji/apply_pitexit_paint.py
3. python3 tools/fuji/edit_pit_exit.py
4. python3 tools/fuji/edit_pit_lane.py
5. python3 tools/fuji/edit_shortcut_island.py
6. python3 tools/fuji/make_trees_cars.py
7. python3 tools/fuji/smooth_landcover.py   (ゲームが使う map/fuji-landcover-hd.png)
(絵の直しを足すときは 1 のあとに apply_area_paint2.py 絵.png 出力フォルダ --add)
