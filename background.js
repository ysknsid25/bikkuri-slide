// service worker: ツールバーアイコンのクリックでアクティブタブに present.js を注入する。
// present.js 側でトグル（起動中なら閉じる）を判断するため、ここでは注入のみ行う。

chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.id) return;

    const url = tab.url || "";
    if (/^(chrome|edge|about|chrome-extension|devtools):/.test(url)) {
        return;
    }

    try {
        await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ["src/present.css"],
        });
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["src/present.js"],
        });
    } catch (err) {
        console.error("[びっくりスライド] 注入に失敗しました:", err);
    }
});
