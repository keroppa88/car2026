# 湘南の地表

湘南は既存の地図 GLB を読み込まない。`map/shonan-city.json` にある現在の形状と、江の島の高さ `map/shonan-terrain.json` から、Three.js の地表メッシュを作る。

地面、水面、砂浜、堤防、道路、白線を上からの優先順位で区分する。各場所に地表は1面だけを作り、色を付けるための重ね面、深度マスク、polygonOffset は使わない。道路と白線は既存の描画関数から形を取得する。島では元の2m格子の三角形で細分し、道路が斜面を貫通しないようにする。

## 砂浜・堤防などを編集する

`map/shonan-city.json` の `beaches`（砂浜）、`piers`（堤防・岸壁）、`rocks`（岩場）、`water`（海岸・川）を編集する。`o` が外周、`h` が穴。座標は東が+x、南が+z、単位m。建物は `buildings`、道路は `roads`。

その後、リポジトリ直下で実行する。元の `.osm` や地図 GLB は不要。

```sh
python tools/shonan/build_surfaces.py
node test/shonan-surfaces.mjs
```

生成には Node.js、Python、numpy、shapely 2.1以上が必要。出力は `map/shonan-surfaces.json` と `map/shonan-surfaces.bin.gz`。地表JSONを更新したら `js/game-config.js` の `surfaceData` のバージョンも更新する。建物なども変えた場合は `cityData` のバージョンも更新する。バイナリのURLには内容のハッシュが自動で入る。

`tools/osm_to_city.py` は過去の素材取得用。今回の固定した形を維持する場合は実行しない。後から形状を調整しても、地表の面の重複や欠落を生成時に検査し、表示と路面種別判定は同じ最終三角形を使う。

東京の地表は従来の経路を維持する。

稲村ヶ崎東端の画像指示による修正は `tools/shonan/edit_inamuragasaki.py` に記録。赤の削除範囲、緑地、護岸の簡単な輪郭をこのファイルで確認できる。道路と建物は変更せず、海岸の修正範囲外の座標も保持している。

江の島周辺の画像指示による修正は `tools/shonan/edit_enoshima.py` に記録。黄色の砂浜、赤の海への削除、オレンジのコンクリート、ピンクの道路接続をまとめて適用できる。橋の付け根の砂浜と港・防波堤のコンクリートは接続を保ち、岬の林と建物・幹線道路は維持する。適用後は上記の地表再生成と検査を実行する。ブラウザ検証は `cd test && npm install && npx playwright install chromium` の後、リポジトリ直下で `node test/enoshima-browser.mjs`。

稲村ヶ崎の2回目の画像指示(道路の海側を砂浜、海側の縁を海へ、砂浜東端と岬の林のあいだを緑地、道路北の細い水路を削除)は `tools/shonan/edit_inamuragasaki2.py` に記録。
稲村ヶ崎の3回目の画像指示(道路の海側=オレンジはコンクリート、西の砂浜とあわせて海岸線を1本のなめらかな線に、突起・へこみなし)は `tools/shonan/edit_inamuragasaki3.py` に記録。
腰越漁港〜小動岬の画像指示(赤=海、オレンジ=コンクリート、黄=砂浜)は `tools/shonan/edit_koshigoe.py` に記録。
