# car2026
<img width="200" height="120" alt="image" src="https://github.com/user-attachments/assets/5e6f880b-6d17-496e-a0bd-47ad4561521c" />
<img width="200" height="120" alt="image" src="https://github.com/user-attachments/assets/cdf9dc30-fae4-4c3c-bce6-22ff77a1821d" />
<img width="200" height="120" alt="image" src="https://github.com/user-attachments/assets/77a16eee-9d8e-4000-b8b4-9d81c8b69fc2" />
<img width="200" height="120" alt="image" src="https://github.com/user-attachments/assets/510e6b44-1510-48fd-bc5f-8f88d162f327" />
<img width="200" height="120" alt="image" src="https://github.com/user-attachments/assets/ae19f323-9352-4bdc-95ac-776b1e3de84e" />
<img width="200" height="120" alt="image" src="https://github.com/user-attachments/assets/0320898c-66f5-4560-b8f6-4b011a113b3e" />
<img width="200" height="120" alt="image" src="https://github.com/user-attachments/assets/8ea8d0af-bf5b-4481-884f-729e6c40832f" />
<img width="200" height="120" alt="image" src="https://github.com/user-attachments/assets/3e432495-3ebe-4e89-9fd8-a5603bee4be1" />
<img width="200" height="120" alt="image" src="https://github.com/user-attachments/assets/927820db-a586-4104-b646-04e3de2df2ca" />
<img width="200" height="120" alt="image" src="https://github.com/user-attachments/assets/ac094cdb-189c-4736-95ae-87a3411d1376" />

## ドライブしながら音楽を聴く。
* 音楽を聴くという行為が難しくなった時代。youtubeなど動画でいくらでも目当ての曲を探して聴けるようにはなったが、目移りして落ち着いて聴くことはないのが現実。
* ゲームの制約によって、音楽を楽しむという行為がはかどるかも。
* 古い曲が多い、車も古い車種。これはレトロピアの発露かもしれない。
> 「レトロトピア（Retrotopia）」とは、社会学者ジグムント・バウマンが提唱した言葉です。未来への希望を失った現代人が、過去の懐かしい時代や古き良き価値観に理想郷（ユートピア）を求める現象や思想を指します。過去への回帰: 先行き不透明な現在や未来を避け、歴史や伝統、昔の生活様式に安心感を求めます。ノスタルジアの蔓延: 社会的な不安や孤独から逃れるため、昔は良かったという記憶や幻想に頼ります。

### 車種
* 2台の車。性能差はなし。
* トヨタAE86は漫画・ゲームなどで非常に著名。
* VOLVO240（1990年代モデル）はホラー映画などで暗い森林を走る際によく出てくるイメージ。

### コースは4種類。
* 首都高速は市街地コースでのレース風。
* 海岸線は海辺の直線を走るだけ。自動運転にして音楽を聴くのがメイン。景色が開けているので空の色の変化などもわかりやすい。
* 森林地帯は曲がりくねった道でのドリフト走行、ラリー風。多少のアップダウンを加えている。
* インディアナポリスはオーバルサーキット。路面傾斜を実装している。

### 音楽
* 全てyoutubeAPIに接続する仕組み。ブラウザによっては広告が入る。小規模趣味レベルでの使用であれば許容されるだろう。
* ラジオはNHKのAM・FM、ネットラジオを聴取できる。
* 音楽リストは手。知っている曲、関連曲、AI紹介曲を一部入れている。
* 音楽に応じて空の色が変わる。一部は手で設定したが、曲数が増えて大変なのでAIが曲イメージに応じて色設定を行った。手直しが必要。

### 開発
* 開発はClaudeCode、CODEXの混合。
* 車はMagicaVoxelで作成。vox型式。VOLVO240はCODEXとMCPとAI提示の写真から原型を作成して手直し。他は手。
* マップはSketchUpで作成。無料版は色情報が落とされたり不具合が出るので、事前に作成しておいたものをフリートライアル期間中に一気に出力した。
* 著名な無料ソフト・Blenderはメニュー多すぎ、ハードルが高そうなので5分で見切りをつけた。MCPを使うにしても、最低限の手直しなどできないといけないし。
* スマホ使用可能にするにはボタン数を大幅に削減せねばならない。ゲームにとっては鬼門。画面の小ささ、ボタン数の削減などの制約によってスマホゲームはここ20年ほど進化がないのでは？
* 森林地帯は描写量が多いので、ノートPCでは重くて動作しない事例があった。通常のデスクトップPCであれば問題ないレベルのはず。
* ブラウザで軽く動作するために背景、車などの描写はこの程度にしている。当然、手間暇の問題も。
* エンジン音は複数の音を発生させて合成。改善余地は相当にある。これはなかなか奥深い分野。コンピュータ内で物理的にエンジン動作をシミュレートして音を作っているサイトがあったりする。

# ●●●●●英訳・English●●●●●
## Listening to music while driving.
* Listening to music has become a surprisingly difficult thing to do in this era. YouTube and similar services make it possible to find and listen to almost any song you want, but in reality, there are so many choices that your attention keeps shifting and you rarely settle down and listen to anything properly.
* The constraints imposed by a game might actually make it easier to enjoy music as an activity in itself.
* There are many old songs, and the cars are old models as well. This may be an expression of Retrotopia.
> “Retrotopia” is a term proposed by sociologist Zygmunt Bauman. It refers to the phenomenon or idea in which modern people, having lost hope in the future, seek a kind of utopia in nostalgic images of the past and in supposedly good old values. A return to the past: rather than facing an uncertain present or future, people seek reassurance in history, tradition, and older ways of life. The spread of nostalgia: as an escape from social anxiety and loneliness, people rely on memories or fantasies that “things were better in the past.”

### Cars
* There are two cars. There is no difference in performance between them.
* The Toyota AE86 is extremely well known through manga, games, and other media.
* The Volvo 240 (1990s model) has the sort of image of a car that often appears in horror movies driving through dark forests.

### There are four courses.
* The Shuto Expressway is an urban course designed with a street-racing feel.
* The coastal route is basically just a straight road along the seaside. The main purpose is to switch on automatic driving and listen to music. Because the scenery is open, changes in the color of the sky are also easy to notice.
* The forest area consists of winding roads designed for drifting and rally-style driving. It also includes some elevation changes.
* Indianapolis is an oval circuit. Banking on the track surface has been implemented.

### Music
* Everything is connected through the YouTube API. Depending on the browser, advertisements may appear. For small-scale hobby use, this is probably acceptable.
* The radio can play NHK AM/FM as well as internet radio.
* The music list is assembled manually. It includes songs I already know, related songs, and some songs recommended by AI.
* The color of the sky changes according to the music. Some colors were configured manually, but as the number of songs increased this became too much work, so AI was used to assign colors based on the image or mood of each song. Some manual adjustment is still necessary.

### Development
* Development was done using a mixture of Claude Code and Codex.
* The cars were created with MagicaVoxel in VOX format. The Volvo 240 was initially generated by Codex using MCP and photos provided to the AI as references, and then manually corrected. The others were made manually.
* The maps were created with SketchUp. The free version sometimes strips color information and has other problems, so I prepared the models in advance and exported everything at once during the free trial period.
* Blender is a famous free application, but it had so many menus that the barrier to entry looked too high, so I gave up on it after about five minutes. Even when using MCP, you still need to be able to make at least basic manual corrections yourself.
* To make the game usable on smartphones, the number of buttons would have to be drastically reduced. This is a major obstacle for games. Perhaps smartphone games have hardly evolved over the past 20 years because of constraints such as small screens and the need to reduce the number of controls.
* The forest area has a high rendering load, and there was one case where it was too heavy to run on a laptop PC. It should run without problems on an ordinary desktop PC.
* To keep it lightweight enough to run in a browser, the backgrounds, cars, and other graphics are kept at roughly this level of detail. Of course, the amount of work involved is another reason.
* The engine sound is created by generating and combining multiple sounds. There is still considerable room for improvement. This is a surprisingly deep field. There are even websites that generate engine sounds by physically simulating the operation of an engine inside a computer.
