from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width":1100,"height":760})
    errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)[:150]))
    pg.goto("http://127.0.0.1:8877/index.html?car=toyota86&course=tokyo")
    pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(6000)
    print("itemCount:", pg.evaluate("()=>document.body.dataset.musicItemCount"))
    pg.keyboard.press("m"); pg.wait_for_timeout(1200)
    # リスト先頭付近の行テキストを読む
    rows = pg.evaluate("""()=>{
      const menu=[...document.querySelectorAll('div')].find(d=>d.textContent.includes('MUSIC SELECT'));
      const lists=[...document.querySelectorAll('div')].filter(d=>d.children.length>30);
      const el=lists[lists.length-1];
      return el?[...el.children].slice(0,6).map(r=>r.textContent):null;}""")
    print("先頭6行:", rows)
    # 見出し行(先頭)を選んでEnter→何も起きないこと(曲名表示が出ない)
    pg.keyboard.press("Enter"); pg.wait_for_timeout(800)
    np = pg.evaluate("()=>document.body.dataset.youtubePlayer||'none'")
    print("Enter後のyoutubePlayer:", np)
    pg.screenshot(path="music_headers.png")
    b.close(); print("errors:", len(errs), errs[:2])
