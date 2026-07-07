/*
 * 記事ノードを元の DOM 位置に残したまま周囲を隠して全画面化する「インプレース方式」。
 * これにより、はてなブログ本来の CSS(シンタックスハイライト・埋め込みカード・表・版面)
 * がすべて元のまま当たる。自前で触るのは「隠す/全画面化/最小 UI」の構造的な範囲のみ。
 */
(() => {
    "use strict";

    if (window.__bikkuriSlide) {
        window.__bikkuriSlide.close();
        return;
    }

    /**
     * 記事要素の抽出(はてな主判定 ＋ 汎用フォールバック)
     * @returns {HTMLElement|null} 記事要素
     */
    function findArticle() {
        const candidates = [
            () => document.querySelector("article.entry"),
            () => document.querySelector('article[class*="entry"]'),
            () => {
                const ec = document.querySelector(".entry-content");
                return ec ? ec.closest("article") || ec : null;
            },
            () =>
                document.querySelector("main article") ||
                document.querySelector("article"),
        ];
        for (const get of candidates) {
            const el = get();
            if (el && el.textContent.trim().length > 0) return el;
        }
        let best = null;
        let bestLen = 0;
        document
            .querySelectorAll(
                "article, main, [role='main'], .content, #content",
            )
            .forEach((el) => {
                const len = el.textContent.trim().length;
                if (len > bestLen) {
                    best = el;
                    bestLen = len;
                }
            });
        return bestLen > 200 ? best : null;
    }

    const article = findArticle();
    if (!article) {
        showToast("記事本文が見つかりませんでした");
        return;
    }

    // 本文コンテナ
    const contentEl = article.querySelector(".entry-content") || article;

    const hiddenEls = []; // 復元用に記録

    /**
     * インプレース化：祖先チェーンをたどり、周囲の兄弟要素を隠す
     */
    function declutter() {
        let node = article;
        while (node && node !== document.body && node.parentElement) {
            const parent = node.parentElement;
            for (const sib of Array.from(parent.children)) {
                if (sib !== node && !sib.classList.contains("bikkuri-hidden")) {
                    sib.classList.add("bikkuri-hidden");
                    hiddenEls.push(sib);
                }
            }
            node = parent;
        }
    }

    // 全画面の対象＝ステージ(＝記事要素)
    const stageEl = article;
    stageEl.classList.add("bikkuri-stage");

    // 全画面時の余白背景を元ページの背景色に合わせる
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const bg =
        bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" && bodyBg !== "transparent"
            ? bodyBg
            : "#ffffff";
    stageEl.style.setProperty("--bikkuri-bg", bg);

    /**
     * スライド分割：本文内の最も浅い見出しレベルで区切る
     * @param {*} el
     * @returns {boolean} 見出し要素かどうか
     */
    function isHeading(el) {
        return /^H[1-6]$/.test(el.tagName);
    }
    function headingLevel(el) {
        return isHeading(el) ? parseInt(el.tagName[1], 10) : null;
    }

    /**
     * 記事ヘッダ(タイトル/日付/タグ)とフッタ(著者/共有/コメント等)を特定する。
     * はてなは article > .entry-inner > [ヘッダ, .entry-content, フッタ] の構造。
     * ヘッダはタイトルスライドでのみ、フッタはスライドモード中は常に非表示にする。
     * @returns {{headerEls: Element[], footerEls: Element[]}}
     */
    function computeChrome() {
        const inner = contentEl.parentElement;
        if (!inner || inner === contentEl || !article.contains(inner)) {
            return { headerEls: [], footerEls: [] };
        }
        const sibs = Array.from(inner.children).filter(
            (c) => c !== indicator && c !== hint,
        );
        const idx = sibs.indexOf(contentEl);
        return {
            headerEls: idx > 0 ? sibs.slice(0, idx) : [],
            footerEls: idx >= 0 ? sibs.slice(idx + 1) : [],
        };
    }

    /**
     * スライドを構築する。
     * slides[i] = { showHeader: boolean, contentEls: Element[] }
     * slide0＝タイトルスライド(ヘッダ＋見出し前の導入)、以降＝本文の各セクション。
     * 区切りは h1〜h3 のいずれかの見出し(SLIDE_HEADING_MAX_LEVEL で調整可)。
     * @returns {{showHeader: boolean, contentEls: Element[]}[]}
     */
    function buildSlides() {
        // 自前で追加した UI(indicator / hint)は分割対象から除外する
        const children = Array.from(contentEl.children).filter(
            (c) => c !== indicator && c !== hint,
        );

        // h1〜h3 のいずれの見出しでもスライドを区切る
        const SLIDE_HEADING_MAX_LEVEL = 3;
        const isBreak = (c) => {
            const lv = headingLevel(c);
            return lv !== null && lv <= SLIDE_HEADING_MAX_LEVEL;
        };

        // 本文を見出しごとのセクションへ分割
        const groups = [];
        let cur = null;
        for (const c of children) {
            if (isBreak(c)) {
                cur = [c];
                groups.push(cur);
            } else {
                if (!cur) {
                    cur = [];
                    groups.push(cur);
                }
                cur.push(c);
            }
        }

        let introGroup = [];
        if (groups.length && !isBreak(groups[0][0])) {
            introGroup = groups.shift();
        }

        const { headerEls, footerEls } = computeChrome();
        state._headerEls = headerEls;
        state._footerEls = footerEls;

        const slides = [];
        if (headerEls.length || introGroup.length) {
            slides.push({ showHeader: true, contentEls: introGroup });
        }
        for (const g of groups)
            slides.push({ showHeader: false, contentEls: g });
        if (slides.length === 0) {
            slides.push({ showHeader: true, contentEls: children });
        }
        return slides;
    }

    // 状態と UI 要素
    const state = {
        phase: "modal", // "modal" | "presenting"
        mode: "reader", // "reader" | "slide"
        slides: [],
        current: 0,
        _headerEls: [],
        _footerEls: [],
    };

    const indicator = document.createElement("div");
    indicator.className = "bikkuri-indicator";
    indicator.style.display = "none";
    stageEl.appendChild(indicator);

    const hint = document.createElement("div");
    hint.className = "bikkuri-hint bikkuri-hint-hide";
    stageEl.appendChild(hint);
    let hintTimer = null;

    function refreshHint(text) {
        clearTimeout(hintTimer);
        hint.textContent = text;
        hint.classList.remove("bikkuri-hint-hide");
        hintTimer = setTimeout(
            () => hint.classList.add("bikkuri-hint-hide"),
            2500,
        );
    }

    /**
     * リーダー / スライド モード
     */
    function clearSlideOff() {
        article
            .querySelectorAll(".bikkuri-slide-off")
            .forEach((el) => el.classList.remove("bikkuri-slide-off"));
        contentEl.classList.remove("bikkuri-slide-off");
    }

    function showSlide(n) {
        state.current = Math.max(0, Math.min(n, state.slides.length - 1));
        const slide = state.slides[state.current];
        const visible = new Set(slide.contentEls);

        // 本文コンテナの子：現在スライドの要素だけ表示
        for (const child of contentEl.children) {
            if (child === indicator || child === hint) continue;
            child.classList.toggle("bikkuri-slide-off", !visible.has(child));
        }
        // 本文コンテナ自体：表示する内容が無ければ隠す(タイトルのみのスライド等)
        contentEl.classList.toggle(
            "bikkuri-slide-off",
            slide.contentEls.length === 0,
        );
        // ヘッダ(タイトル/日付/タグ)：タイトルスライドのみ表示
        for (const h of state._headerEls) {
            h.classList.toggle("bikkuri-slide-off", !slide.showHeader);
        }
        // フッタ(著者/共有/コメント等)：スライドモード中は常に非表示
        for (const f of state._footerEls) {
            f.classList.add("bikkuri-slide-off");
        }

        indicator.textContent = `${state.current + 1} / ${state.slides.length}`;
        stageEl.scrollTop = 0;
        window.scrollTo(0, 0);
    }

    function enterReader() {
        state.mode = "reader";
        clearSlideOff();
        indicator.style.display = "none";
        refreshHint("リーダーモード");
    }

    function enterSlide() {
        state.slides = buildSlides();
        state.mode = "slide";
        indicator.style.display = "";
        showSlide(Math.min(state.current, state.slides.length - 1));
        refreshHint("スライドモード(←→で送り)");
    }

    /**
     * 全画面(Fullscreen API)
     */
    function enterFullscreen() {
        if (!document.fullscreenElement && stageEl.requestFullscreen) {
            stageEl.requestFullscreen().catch(() => {});
        }
    }
    function toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        } else {
            enterFullscreen();
        }
    }

    /**
     * キー操作
     */
    function next() {
        if (state.mode === "slide") showSlide(state.current + 1);
    }
    function prev() {
        if (state.mode === "slide") showSlide(state.current - 1);
    }

    function onKeyDown(e) {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const k = e.key;
        if (state.phase === "modal") {
            if (k === "Enter") {
                startPresentation(getSelectedMode());
                e.preventDefault();
            } else if (k === "Escape") {
                close();
                e.preventDefault();
            }
            return;
        }

        if (k === "Escape") {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            } else {
                close();
            }
            return;
        }

        switch (k) {
            case "f":
            case "F":
                toggleFullscreen();
                e.preventDefault();
                break;
            case "s":
            case "S":
                enterSlide();
                e.preventDefault();
                break;
            case "r":
            case "R":
                enterReader();
                e.preventDefault();
                break;
            case "ArrowRight":
            case "PageDown":
                if (state.mode === "slide") {
                    next();
                    e.preventDefault();
                }
                break;
            case " ": // Space
                if (state.mode === "slide") {
                    next();
                    e.preventDefault();
                }
                break;
            case "ArrowLeft":
            case "PageUp":
                if (state.mode === "slide") {
                    prev();
                    e.preventDefault();
                }
                break;
            case "Home":
                if (state.mode === "slide") {
                    showSlide(0);
                    e.preventDefault();
                }
                break;
            case "End":
                if (state.mode === "slide") {
                    showSlide(state.slides.length - 1);
                    e.preventDefault();
                }
                break;
        }
    }

    function onFsChange() {
        // 全画面を抜けたらプレゼンを終了し、元のブログ表示へ完全復帰する
        if (state.phase === "presenting" && !document.fullscreenElement) {
            close();
        }
    }

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("fullscreenchange", onFsChange);

    /**
     * 起動モーダル(表示モードの選択とキー操作の案内)
     */
    let modalEl = null;

    // 小さな要素生成ヘルパー
    function el(tag, props, children) {
        const node = document.createElement(tag);
        if (props) Object.assign(node, props);
        for (const c of children || []) {
            node.append(c);
        }
        return node;
    }

    function getSelectedMode() {
        const checked = modalEl
            ? modalEl.querySelector('input[name="bikkuri-mode"]:checked')
            : null;
        return checked ? checked.value : "reader";
    }

    function radioOption(value, checked, title, desc) {
        const input = el("input", {
            type: "radio",
            name: "bikkuri-mode",
            value,
        });
        input.checked = checked;
        return el("label", { className: "bikkuri-radio" }, [
            input,
            el("span", {}, [
                el("p", {
                    className: "bikkuri-radio-title",
                    textContent: title,
                }),
                el("p", { className: "bikkuri-radio-desc", textContent: desc }),
            ]),
        ]);
    }

    function keyRow(keys, desc) {
        const dt = el(
            "dt",
            {},
            keys.map((k) => el("kbd", { textContent: k })),
        );
        return [dt, el("dd", { textContent: desc })];
    }

    function showModal() {
        const heading = el("h2", { textContent: "びっくりスライド" });
        const sub = el("p", {
            className: "bikkuri-modal-sub",
            textContent:
                "表示モードを選んで開始します(記事本文だけを全画面表示)",
        });

        const fieldset = el("fieldset", {}, [
            radioOption(
                "reader",
                true,
                "リーダーモード",
                "記事全体を全画面で通し表示(縦スクロール)",
            ),
            radioOption(
                "slide",
                false,
                "プレゼンモード",
                "見出しごとにスライドを1枚ずつ送って表示",
            ),
        ]);

        const dl = el("dl", {}, [
            ...keyRow(["→", "Space"], "次のスライド(プレゼンモード)"),
            ...keyRow(["←"], "前のスライド"),
            ...keyRow(["S"], "プレゼンモードへ切替"),
            ...keyRow(["R"], "リーダーモードへ切替"),
            ...keyRow(["Esc", "F"], "全画面を終了して元のブログへ戻る"),
        ]);
        const keys = el("div", { className: "bikkuri-keys" }, [
            el("div", {
                className: "bikkuri-keys-head",
                textContent: "プレゼンテーション中のキー操作",
            }),
            dl,
        ]);

        const cancelBtn = el("button", {
            type: "button",
            className: "bikkuri-btn bikkuri-btn-ghost",
            textContent: "キャンセル",
        });
        cancelBtn.addEventListener("click", () => close());

        const startBtn = el("button", {
            type: "button",
            className: "bikkuri-btn bikkuri-btn-primary",
            textContent: "表示",
        });
        startBtn.addEventListener("click", () =>
            startPresentation(getSelectedMode()),
        );

        const actions = el("div", { className: "bikkuri-modal-actions" }, [
            cancelBtn,
            startBtn,
        ]);

        const modal = el("div", { className: "bikkuri-modal" }, [
            heading,
            sub,
            fieldset,
            keys,
            actions,
        ]);
        modalEl = el("div", { className: "bikkuri-modal-overlay" }, [modal]);
        modalEl.addEventListener("click", (e) => {
            if (e.target === modalEl) close();
        });
        document.body.appendChild(modalEl);
        startBtn.focus();
    }

    function removeModal() {
        if (modalEl) {
            modalEl.remove();
            modalEl = null;
        }
    }

    /**
     * 表示開始：モーダルを閉じ、記事をインプレース化して全画面表示する。
     * 呼び出しは「表示」ボタン等のユーザー操作起点である必要がある(全画面要求のため)。
     * @param {"reader"|"slide"} mode
     */
    function startPresentation(mode) {
        removeModal();
        declutter();
        state.phase = "presenting";
        if (mode === "slide") enterSlide();
        else enterReader();
        enterFullscreen();
    }

    /**
     * クローズ処理(元ページ完全復帰)
     */
    function close() {
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("fullscreenchange", onFsChange);
        clearTimeout(hintTimer);

        if (document.fullscreenElement)
            document.exitFullscreen().catch(() => {});

        removeModal();
        clearSlideOff();
        hiddenEls.forEach((el) => el.classList.remove("bikkuri-hidden"));
        stageEl.classList.remove("bikkuri-stage");
        stageEl.style.removeProperty("--bikkuri-bg");
        indicator.remove();
        hint.remove();

        delete window.__bikkuriSlide;
    }

    /**
     * トースト
     * 記事が見つからない等の通知に利用する
     * @param {string} msg
     */
    function showToast(msg) {
        const t = document.createElement("div");
        t.className = "bikkuri-hint";
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => {
            t.classList.add("bikkuri-hint-hide");
            setTimeout(() => t.remove(), 500);
        }, 2000);
    }

    showModal();
    window.__bikkuriSlide = { close };
})();
