# 系統介紹 PDF（public/mental-hug-intro.pdf）

介紹用 DM，內含線上試用連結與 QR，公開網址（免登入）：
https://mental-hug.crownai.ink/mental-hug-intro.pdf

## 重新產生

```bash
cd docs/brochure
npm i                 # 唯一相依 qrcode（不進主專案 package.json）
node build.js         # 產出 mental-hug-intro.pdf
cp mental-hug-intro.pdf ../../public/mental-hug-intro.pdf
```

- 改內容編輯 `brochure.html`；`{{QR_STAFF}}` / `{{QR_CLIENT}}` 由 build.js 置換成 QR data URI。
- 以 playwright 的 chromium（`/root/.cache/ms-playwright/chromium-1223/...`）headless 列印，
  連結會保留為可點擊的 PDF annotation。
- 中文字型需要 `fonts-noto-cjk`（已安裝）。
- 版面靠自然分頁，勿加強制 pagebreak，否則會出現整頁留白。
  目前為 5 頁，各頁填充率 86–96%。增補內容後請確認最後一頁不是只剩零星幾行，
  必要時壓縮頁尾或刪減卡片文字；判斷方式見下方「產出檢查」。
- 內容更新後務必 `cp mental-hug-intro.pdf ../../public/`，公開網址才會換成新版（同一 URL，不必換連結）。
- 系統有新功能時記得同步這份，否則對外文件會與實際功能脫節。
  文件中會隨版本變動的數字：**19 個模組、5 份報表、5 種量表**，改動時一併更新首頁統計列、
  「統計報表與匯出」卡片與「安全與資料保全」段落。模組數以 `src/auth.js` 的 `MODULES` 為準，
  報表數以 `src/routes/org.js` 的 `EXPORTS` 為準，量表以 `src/scales.js` 的 `SCALE_KEYS` 為準：

  ```bash
  node -e "console.log(require('./src/auth').MODULES.length)"          # 於專案根目錄執行
  node -e "console.log(require('./src/scales').SCALE_KEYS.length)"
  ```

## 產出檢查

```bash
pdfinfo mental-hug-intro.pdf | grep Pages          # 目前 5 頁
pdftoppm -png -r 60 mental-hug-intro.pdf pg        # 轉圖目視檢查版面
curl -sI https://mental-hug.crownai.ink/mental-hug-intro.pdf | head -3
rm -f pg-*.png build.html                        # 檢查完清掉中間產物
```

各頁填充率（有內容的最後一列位置佔頁高的比例）可用這段確認，低於約 60% 就該壓縮：

```bash
python3 -c "
from PIL import Image; import glob
for f in sorted(glob.glob('pg-*.png')):
    im=Image.open(f).convert('L'); w,h=im.size; px=im.load(); last=0
    for y in range(h-1,-1,-1):
        if min(px[x,y] for x in range(0,w,4))<235: last=y; break
    print(f, '填充率 %.0f%%'%(last/h*100))"
```

`build.html` 是置換 QR 後的中間產物，供除錯用，可安全刪除。

## 內容原則

- 文件描述的功能必須實際存在，不寫「規劃中」當賣點。法規數值（積分下限、通報時限、
  扣繳率）在系統中皆為可調設定，文件也要標明可調，避免被當成法律意見。
- 心理量表為篩檢工具，文件須標示分數僅供臨床判讀參考、不等同診斷。
- 引用法條（心理師法第 17 條、個資法第 8 條等）前先確認條號正確。
