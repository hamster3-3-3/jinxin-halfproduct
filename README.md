# 晉欣半成品儀表板

網站現在會優先讀取預先產生的精簡 JSON，只有 JSON 尚未產生或載入失敗時，才在瀏覽器內解析 Excel。這能顯著降低首次讀取時間與瀏覽器記憶體用量，同時保留原本 Excel 作為資料來源與備援。

## 日常更新方式

1. 把新的 Excel 放入 `data/年/月/`，不需要手動修改 `manifest.json`。
2. 將 Excel 變更推送到 GitHub 的 `main` 分支。
3. GitHub Actions 會自動掃描全部 Excel、更新 `data/manifest.json`、執行轉檔與驗證，並把產生的 JSON 提交回 Repository。
4. GitHub Pages 更新後，網站會自動讀取新的 JSON。

若 GitHub Actions 顯示無法提交，請到 Repository 的 **Settings → Actions → General → Workflow permissions**，選擇 **Read and write permissions**。

## 在電腦上手動轉檔

需要 Node.js 20 或更新版本：

```bash
npm install
npm run convert:data
npm run check:data
```

轉檔器會自動掃描 `data` 下所有年份與月份資料夾，直接重用 `index.html` 內的資料解析規則，並以 Excel 雜湊值判斷是否需要重做；沒有異動的檔案會跳過。

## 檔案說明

- `scripts/convert-excel-to-json.cjs`：Excel → JSON 轉檔與去重。
- `scripts/check-json-data.cjs`：檢查來源雜湊、列數、檔案大小及 JSON 結構。
- `.github/workflows/convert-excel-to-json.yml`：推送 Excel 後自動轉檔。
- `data-json/`：網站實際優先讀取的資料。
- `data/json-manifest.json`：Excel 與 JSON 的對照及版本資訊。
