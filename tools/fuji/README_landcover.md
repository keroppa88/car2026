# 富士: 地面の塗り分けを作り直す
まとめて: sh tools/fuji/rebuild_landcover.sh 空撮.png 出力フォルダ   (下の順番を全部実行する)
真上ビューの絵の直しは tools/fuji/paint/topview_overrides.png にたまっている(絵とカメラは paint/ の *_reg.png・cam_*.json)。

空撮(scratchpad の mosaic.png)はリポジトリに入れていない。手で塗った直しは tools/fuji/paint/area_overrides.png に残る。

1. python3 tools/fuji/make_landcover_mosaic.py mosaic.png 出力フォルダ
2. python3 tools/fuji/apply_pitexit_paint.py
3. python3 tools/fuji/edit_pit_exit.py
4. python3 tools/fuji/edit_pit_lane.py
4a. python3 tools/fuji/merge_topview.py   (真上ビューの絵の直しをいちばん上に)
5. python3 tools/fuji/edit_shortcut_island.py
5a. python3 tools/fuji/regularize_course_side.py   (コースわきをコースに平行な帯に、しみ消し)
5b. python3 tools/fuji/asphalt_rules.py   (アスファルトは道・退避エリア・駐車場・建物まわりだけ)
5c. python3 tools/fuji/edit_shortcut_island.py   (もう一度)
6. python3 tools/fuji/make_trees_cars.py
7. python3 tools/fuji/smooth_landcover.py   (ゲームが使う map/fuji-landcover-hd.png)
(絵の直しを足すとき: 真上ビューの絵は apply_topview_paint.py 絵 カメラ.json [--red 草地|舗装] [--blue 草地|舗装](topview_overrides.png にたまる。あとの絵ほど上)。赤で囲む = アスファルト、青で塗る = 草地。直しは area_overrides.png に残り、毎回いちばん最後に重なる)
