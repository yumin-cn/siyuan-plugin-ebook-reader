/* 打开页签 */
import ePub from "@likecoin/epub-ts";
import wechatQR from "./assets/wechat.png?inline";
import alipayQR from "./assets/alipay.png?inline";
import avatarImg from "./assets/avatar.png?inline";
import { displayName, escapeHTML, svg, showToast, copyText, assetURL, fetchBookBytes } from "./util";
import { loadStateAsync, saveState, flushState } from "./state";
import {
    getActiveWnd, getTabClass, findEpubTab, refreshWndHeaderState, isLayout
} from "./layout";
import {
    registerView, restoreMarksForView, bindMarkClick, renderMarkList,
    showUtil, restoreMarks, removeIntersectingMarks, cfiSpineIndex,
    closeUtil, isUtilVisible, isSelectionSettled, settleAllViews,
    deferSelection, scheduleSelectionPanel
} from "./annotation";
import { buildMarkRef } from "./markref";
import { installGuard, isJumping, requestJump } from "./jump";
import { installQueueGuards } from "./epubq";
import { bindScrollChapters, jumpApi } from "./chapters";
import { renderTOC, highlightTOC } from "./toc";
import { resizeRendition } from "./resize";
import type { ReaderApi, ReaderState } from "./types";

/* 阅读进度（state.progress）参数
 * - 记录挂在 relocated（滚动时天然触发）；不另挂 scroll 监听
 * - 记录门槛 1.5s：relocated 在补章/回流时也会连发，节流避免高频写盘
 * - 恢复延迟 1.4s：必须晚于开书首屏 requestJump，让首屏意图先落地，
 *   否则恢复意图会被首屏覆盖（同 seq 竞争，谁后登记谁赢） */
const PROGRESS_SAVE_GAP = 1500;
const PROGRESS_RESTORE_DELAY = 1400;

/** 阅读进度指纹 = 章数:首章href:末章href:字节数。
 *  比页码缓存严：进度存单个 cfi 偏移，书一改就可能指错位；多抓末章+字节数以覆盖
 *  「改中间章/ 换文件」。不与 state.locations 共用是怕换钥匙作废所有人已缓存的页码。
 *  漏网：仅改中间章文字且章结构与字节数都不变 → display(cfi) fallback 到该章开头，
 *  不会白屏。 */
function progressFingerprint(api: any): string {
    try {
        const items = api.book && api.book.spine && api.book.spine.items;
        if (!items || !items.length) return "";
        const last = items[items.length - 1];
        return items.length + ":" + (items[0] ? items[0].href : "") + ":" +
               (last ? last.href : "") + ":" + (api.__bookBytes || 0);
    } catch (e) { return ""; }
}

/* 阅读器 DOM 模板（桌面页签 panel 与手机全屏层共用） */
export function readerHTML(path: string): string {
    return '<div class="epub-mini" tabindex="-1" data-epub-path="' +
           escapeHTML(path) + '">' +
               '<div class="epub-mini__toolbar">' +
               '<button class="epub-mini__toc-btn toggled" data-side="toc" title="目录（Tab 开/关）">' +
               /* 文字包 span：手机端 CSS 隐藏文字只留图标，桌面端不受影响 */
               svg("iconList") + '<span class="epub-mini__toc-text">目录</span></button>' +
               '<button class="epub-mini__toc-btn" data-side="mark" title="标注列表">' +
               svg("iconBookmark") + '<span class="epub-mini__toc-text">标注</span></button>' +
               '<span class="epub-mini__fsbar">' +
               svg("ymerFontSize", "epub-mini__fs-icon") +
               '<input class="epub-mini__fs-box" type="text" value="16px" enterkeyhint="done">' +
               '</span>' +
               '<span class="epub-mini__toolbar-divider"></span>' +
               '<span class="epub-mini__pagebar">' +
               '<input class="epub-mini__page-box" type="text" value="--" enterkeyhint="done">' +
               '<span class="epub-mini__page-total">/--页·--%</span>' +
               '</span>' +
               '<span style="flex:1"></span>' +
               '<span class="epub-mini__night"><span class="epub-mini__night-knob">' +
               '<svg class="icon-sun"><use xlink:href="#ymerSun"></use></svg>' +
               '<svg class="icon-moon"><use xlink:href="#ymerMoon"></use></svg>' +
               '</span></span>' +
               '<span class="epub-mini__toolbar-divider"></span>' +
               '<button class="epub-mini__author-btn">' + svg("ymerUser") + '<span class="epub-mini__author-text">作者</span>' +
               '<svg class="epub-mini__author-chevron"><use xlink:href="#ymerChevronRight"></use></svg></button>' +
               '</div>' +
               '<div class="epub-mini__sidebar">' +
               '<div class="epub-mini__sidebar-content">' +
               '<div class="epub-mini__pane epub-mini__pane--toc"><div class="epub-mini__toc-empty">加载中…</div></div>' +
               '<div class="epub-mini__pane epub-mini__pane--mark fn__none"><div class="epub-mini__mark-list"></div></div>' +
               '</div></div>' +
               '<div class="epub-mini__viewer"></div>' +
               '<div class="epub-mini__page-tip"></div>' +
               /* 作者卡片（收款码/头像均 base64 内联，离线可用；头像加载失败时 JS 兜底为「于」字圆形） */
               '<div class="author-card">' +
               '<div class="author-card__header">' +
               '<a class="author-card__avatar-link" data-url="https://space.bilibili.com/195367898" title="前往 B站主页">' +
               '<img class="author-card__avatar" src="' + avatarImg + '" alt="于民">' +
               '</a>' +
               '<div><div class="author-card__name">于民</div>' +
               '<div class="author-card__desc">开发不易，感谢各位伙伴支持。</div></div></div>' +
               '<div class="author-links-row">' +
               '<a data-url="https://space.bilibili.com/195367898">' + svg("ymerBili") + 'B站主页</a>' +
               '<span class="sep">|</span>' +
               '<a class="douyin" data-url="https://v.douyin.com/Z82hRCcp8f4/">' + svg("ymerDouyin") + '抖音主页</a>' +
               '</div>' +
               '<div class="author-divider"></div>' +
               '<div class="author-reward">' +
               '<div class="author-reward__title">投喂一下这只野生开发者~</div>' +
               '<div class="author-qrcodes-stage">' +
               '<div class="author-qrcode" data-qr="wechat">' +
               '<img class="author-qrcode__img" src="' + wechatQR + '" alt="微信收款码">' +
               '<span class="author-qrcode__label wechat">微信</span></div>' +
               '<div class="author-qrcode" data-qr="alipay">' +
               '<img class="author-qrcode__img" src="' + alipayQR + '" alt="支付宝收款码">' +
               '<span class="author-qrcode__label alipay">支付宝</span></div>' +
               '</div></div></div>' +
               '<div class="epub-mini__util b3-menu fn__none">' +
               '<div class="epub-mini__colors" style="display:flex;align-items:center;padding:0 4px"></div>' +
               '<div class="b3-menu__separator" style="margin-top:8px"></div>' +
               '<button class="b3-menu__item" data-util="toggle">' + svg("iconPaintBucket", "b3-menu__icon") + '<span class="b3-menu__label">隐藏背景</span></button>' +
               '<button class="b3-menu__item" data-util="copy">' + svg("iconRef", "b3-menu__icon") + '<span class="b3-menu__label">复制标注</span></button>' +
               '<button class="b3-menu__item" data-util="remove">' + svg("iconTrashcan", "b3-menu__icon") + '<span class="b3-menu__label">移除高亮</span></button>' +
               '</div>' +
               /* 加载态：中心扫描环 + 外圈三点环绕 + 呼吸文字（纯 CSS 动画，用户 2026-10-05 原型）。
                * 文字单独成元素，失败态用 --plain 只留这一行字。 */
               '<div class="epub-mini__tip"><div class="epub-mini__tip-inner">' +
               '<div class="epub-mini__tip-loader">' +
               '<div class="epub-mini__tip-ring"><svg viewBox="0 0 48 48">' +
               '<circle class="epub-tip-track" cx="24" cy="24" r="18"></circle>' +
               '<circle class="epub-tip-bar" cx="24" cy="24" r="18"></circle>' +
               '</svg></div>' +
               '<div class="epub-mini__tip-dot"></div>' +
               '<div class="epub-mini__tip-dot"></div>' +
               '<div class="epub-mini__tip-dot"></div>' +
               '</div>' +
               '<div class="epub-mini__tip-text">EPUB 加载中</div>' +
               '</div></div></div>';
}

/* 渲染 + 交互接线（桌面/手机共用核心）：往 panel（已含 readerHTML 的 DOM）里
 * 装 epub.js、绑全部事件。返回 api/渲染器/销毁函数。
 * state 由调用方先经 loadStateAsync 取好（标注存插件数据目录，随思源同步）。 */
export function wireReader(panel: HTMLElement, path: string, state: ReaderState) {
    let rend: any = null, book: any = null;
    const q = function (sel: string): any { return panel.querySelector(sel); };
    const host = q(".epub-mini__viewer");
    const tip = q(".epub-mini__tip");
    const root: any = q(".epub-mini");
    /* 加载提示：扫描环 + 呼吸文字，动画全在 CSS 里跑，这里只切文字与形态
     *（loading=true 呼吸文字；false → --plain 收成一行静态文字）。命名 setLoadTip
     * 以区别同作用域的悬停提示 showTip(anchor)。 */
    const tipText: any = tip.querySelector(".epub-mini__tip-text");
    function setLoadTip(text: string, loading: boolean) {
        tip.classList.remove("fn__none");
        if (!tipText) { tip.textContent = text; return; }   // 兜底：结构被改坏时别静默
        tipText.textContent = text;
        tip.classList.toggle("epub-mini__tip--plain", !loading);
    }
    function hideTip() {
        tip.classList.add("fn__none");
    }
    const api: ReaderApi = { path: path, root: root, viewEl: host, tocFlat: [], state: state };
            // 侧栏页签：目录 / 标注（点击当前页签 = 收起侧栏）
            function showPane(side: string) {
                const btns = panel.querySelectorAll(".epub-mini__toc-btn");
                for (let i = 0; i < btns.length; i++) {
                    btns[i].classList.toggle("toggled", btns[i].getAttribute("data-side") === side);
                }
                root.querySelector(".epub-mini__pane--toc").classList.toggle("fn__none", side !== "toc");
                root.querySelector(".epub-mini__pane--mark").classList.toggle("fn__none", side !== "mark");
                root.classList.add("epub-mini--sidebar-open");
            }
            const sideBtns = panel.querySelectorAll(".epub-mini__toc-btn");
            for (let si = 0; si < sideBtns.length; si++) {
                (function (btn: Element) {
                    btn.addEventListener("click", function () {
                        const side = btn.getAttribute("data-side");
                        const pane = root.querySelector(".epub-mini__pane--" + side);
                        if (btn.classList.contains("toggled") && !pane.classList.contains("fn__none")) {
                            root.classList.toggle("epub-mini--sidebar-open"); // 当前页签再点 = 收/开侧栏
                        } else {
                            showPane(side);
                        }
                    });
                })(sideBtns[si]);
            }
            /* Tab 快捷键：开/关目录侧栏（面板焦点由此接；焦点在章节 iframe 内由 bindMarkClick 接） */
            function toggleSidebar() {
                if (root.classList.contains("epub-mini--sidebar-open")) {
                    root.classList.remove("epub-mini--sidebar-open");
                    return;
                }
                const toggledBtn = q(".epub-mini__toc-btn.toggled") as HTMLElement | null;
                const side = (toggledBtn && toggledBtn.getAttribute("data-side")) || "toc";
                const pane = root.querySelector(".epub-mini__pane--" + side);
                if (!pane || pane.classList.contains("fn__none")) showPane(side);
                else root.classList.add("epub-mini--sidebar-open");
            }
            api.__toggleSidebar = toggleSidebar;
            api.__showPane = showPane; // 手机端右滑手势循环目录/标注用
            /* Tab 快捷键接线（全局捕获）：面板/页签头/思源主文档任意处聚焦都能响应。
             * 旧方案只挂 panelElement keydown，焦点在页签头或主文档 body 时按 Tab 无反应。
             * 多个 epub 页签（含分屏）时只切「最近获得焦点」的那个；输入框/富编辑内不劫持。 */
            const tabReg: any[] = (window as any).__ymerEpubTabs = (window as any).__ymerEpubTabs || [];
            const regEntry: any = { root: root, toggle: toggleSidebar, ts: 0 };
            tabReg.push(regEntry);
            api.__tabRegEntry = regEntry;
            root.addEventListener("focusin", function () { regEntry.ts = Date.now(); });
            if (!(window as any).__ymerEpubKeyBound) {
                (window as any).__ymerEpubKeyBound = true;
                document.addEventListener("keydown", function (ev: KeyboardEvent) {
                    if (ev.key !== "Tab") return;
                    const tgt = ev.target as HTMLElement;
                    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
                    const regs: any[] = (window as any).__ymerEpubTabs || [];
                    let best: any = null;
                    for (let i = 0; i < regs.length; i++) {
                        const e = regs[i];
                        if (!e.root.isConnected || !e.root.getClientRects().length) continue; // 面板隐藏 = 非当前页签
                        if (!best || e.ts > best.ts) best = e;
                    }
                    if (!best) return;
                    ev.preventDefault();
                    ev.stopPropagation();
                    try { best.toggle(); } catch (e) {}
                }, true);
            }
            /* 页码指示：方框=当前页（滚轮 ±1、输入回车跳转），右侧 = 共x页·百分比。
             * 页码基于 epub.js locations（1024 字/页），生成完成前显示 -- */
            const pagebar = q(".epub-mini__pagebar");
            const pageBox = q(".epub-mini__page-box");
            const pageTotal = q(".epub-mini__page-total");
            const pageTip = q(".epub-mini__page-tip");
            api.__pageEditing = false;
            api.__curPage = null; // 0 基 locations 索引
            api.updatePageInfo = function () {
                if (!api.rend) return;
                let loc: any = null;
                try { loc = api.rend.currentLocation(); } catch (e) {}
                if (!loc || !loc.start) return;
                const cfi = loc.start.cfi;
                let page: number | null = null, pct: number | null = null;
                const total = api.locTotal || 0;
                if (api.book && api.book.locations && total) {
                    try {
                        page = api.book.locations.locationFromCfi(cfi); // 0 基，可能 -1（未就绪）
                        const p = api.book.locations.percentageFromCfi(cfi);
                        if (p != null && !isNaN(p)) pct = Math.round(p * 100);
                    } catch (e) {}
                }
                if (page != null && page >= 0 && total) {
                    api.__curPage = page;
                    if (!api.__pageEditing) (pageBox as HTMLInputElement).value = String(page + 1);
                    pageTotal.textContent = "/" + total + "页·" + (pct != null ? pct : "--") + "%";
                } else {
                    api.__curPage = null;
                    if (!api.__pageEditing) (pageBox as HTMLInputElement).value = "--";
                    // 页码定位点未生成：按章节进度估个百分比先顶着，生成后自动换精确值
                    const si = cfiSpineIndex(cfi);
                    const sc = api.book && api.book.spine && api.book.spine.items ? api.book.spine.items.length : 0;
                    if (si != null && sc) {
                        const ep = Math.min(99, Math.max(1, Math.round((si + 0.5) / sc * 100)));
                        pageTotal.textContent = "/--页·约" + ep + "%";
                    } else {
                        pageTotal.textContent = "/--页·--%";
                    }
                }
                if ((pageTip as HTMLElement).style.display === "block") refreshPageTip(); // 悬停中翻页 → 提示实时刷新
            };
            function goToPage(n: number) { // n：1 基目标页
                if (!api.locTotal) { showToast(api, "页码统计生成中，请稍候"); return; }
                if (isNaN(n)) return;
                n = Math.max(1, Math.min(api.locTotal, n));
                let cfi: any = null;
                try { cfi = api.book.locations.cfiFromLocation(n - 1); } catch (e) {}
                if (!cfi || cfi === -1) return;
                jumpApi(api, cfi);
            }
            function refreshPageTip() {
                if (api.__tipAnchor) showTip(api.__tipAnchor);
            }
            /* 通用悬停提示：pageTip 元素 + 按锚点生成内容（页码/字号/夜间共用） */
            function showTip(anchor: HTMLElement) {
                api.__tipAnchor = anchor;
                let html: string;
                if (anchor === fsbar) {
                    html = "字号 " + (parseInt(String(api.state.fontSize), 10) || 20) + "px<br>滚轮调节 · 输入回车应用（10–100）";
                } else if (anchor === nightBtn) {
                    html = api.night ? "夜间模式：开<br>点击切回日间" : "夜间模式：关<br>点击切为夜间（导航/目录/正文全深色）";
                } else {
                    const total = api.locTotal || 0;
                    html = total
                        ? "第 <b>" + (api.__curPage != null ? api.__curPage + 1 : "--") + "</b> / " + total + " 页<br>滚轮翻页 · 输入页码回车跳转"
                        : "页码统计生成中…<br>滚轮翻页 · 输入页码回车跳转";
                }
                pageTip.innerHTML = html;
                (pageTip as HTMLElement).style.display = "block";
                const pr = anchor.getBoundingClientRect();
                const rr = root.getBoundingClientRect();
                (pageTip as HTMLElement).style.left = Math.min(Math.max(pr.left - rr.left - 40, 8), Math.max(rr.width - 230, 8)) + "px";
                (pageTip as HTMLElement).style.top = (pr.bottom - rr.top + 4) + "px";
            }
            pagebar.addEventListener("wheel", function (ev: WheelEvent) {
                ev.preventDefault(); ev.stopPropagation();
                const base = api.__curPage != null ? api.__curPage : 0;
                goToPage(base + 1 + (ev.deltaY > 0 ? 1 : -1));
            }, { passive: false });
            pageBox.addEventListener("focus", function (this: HTMLInputElement) {
                api.__pageEditing = true;
                const self = this;
                setTimeout(function () { self.select(); }, 0);
            });
            pageBox.addEventListener("keydown", function (this: HTMLInputElement, ev: KeyboardEvent) {
                ev.stopPropagation(); // 别触发思源全局快捷键
                if (ev.key === "Enter") {
                    const n = parseInt(this.value, 10);
                    if (isNaN(n)) { showToast(api, "请输入数字页码"); return; }
                    goToPage(n);
                    this.blur();
                } else if (ev.key === "Escape") {
                    api.__pageEditing = false;
                    api.updatePageInfo();
                    this.blur();
                }
            });
            pageBox.addEventListener("blur", function () {
                api.__pageEditing = false;
                /* 手机端没有回车键：失焦 = 按输入页码跳转；桌面端保持原样（丢弃） */
                if ((api as any).__isMobile) {
                    const n = parseInt((this as HTMLInputElement).value, 10);
                    if (!isNaN(n)) { goToPage(n); return; }
                }
                api.updatePageInfo();
            });
            pagebar.addEventListener("mouseenter", function () { showTip(pagebar); });
            pagebar.addEventListener("mouseleave", function () {
                (pageTip as HTMLElement).style.display = "none";
                api.__tipAnchor = null;
            });
            /* 字号框：滚轮 ±1px（10–100），输入回车应用；随书记忆（未调过的书默认 20） */
            const fsbar = q(".epub-mini__fsbar");
            const fsBox = q(".epub-mini__fs-box");
            if (!api.state.fontSize) api.state.fontSize = 20;
            api.__fsTimer = null;
            function applyFontSize(save: boolean) {
                const v = Math.max(10, Math.min(100, parseInt(String(api.state.fontSize), 10) || 20));
                api.state.fontSize = v;
                if (!api.__fsEditing) (fsBox as HTMLInputElement).value = v + "px";
                const reg = api.viewRegistry || [];
                for (let i = 0; i < reg.length; i++) {
                    const c = reg[i].contents;
                    try { if (c && c.document) c.document.documentElement.style.fontSize = v + "px"; } catch (e) {}
                }
                if (save) {
                    saveState(api);
                    try { restoreMarks(api); } catch (e) {} // 同步重绘：读矩形强制重排，坐标即时正确（重绘仅毫秒级）
                    clearTimeout(api.__fsTimer);
                    api.__fsTimer = setTimeout(function () {
                        try { api.rend.manager.resize(); } catch (e) {} // 重的尺寸调整仍走防抖
                        try { restoreMarks(api); } catch (e) {}
                        setTimeout(function () { try { restoreMarks(api); } catch (e) {} }, 350); // 布局稳定后兜底校准
                    }, 250);
                }
            }
            fsbar.addEventListener("wheel", function (ev: WheelEvent) {
                ev.preventDefault(); ev.stopPropagation();
                api.state.fontSize = Math.max(10, Math.min(100, (parseInt(String(api.state.fontSize), 10) || 20) + (ev.deltaY > 0 ? -1 : 1)));
                applyFontSize(true);
                if ((pageTip as HTMLElement).style.display === "block") showTip(fsbar);
            }, { passive: false });
            fsbar.addEventListener("mouseenter", function () { showTip(fsbar); });
            fsbar.addEventListener("mouseleave", function () { (pageTip as HTMLElement).style.display = "none"; api.__tipAnchor = null; });
            fsBox.addEventListener("focus", function (this: HTMLInputElement) {
                api.__fsEditing = true;
                const self = this;
                setTimeout(function () { self.select(); }, 0);
            });
            fsBox.addEventListener("keydown", function (this: HTMLInputElement, ev: KeyboardEvent) {
                ev.stopPropagation();
                if (ev.key === "Enter") {
                    const v = parseInt(this.value, 10);
                    if (isNaN(v)) { showToast(api, "请输入数字字号（10–100）"); return; }
                    api.state.fontSize = v;
                    applyFontSize(true);
                    this.blur();
                } else if (ev.key === "Escape") {
                    api.__fsEditing = false;
                    applyFontSize(false);
                    this.blur();
                }
            });
            fsBox.addEventListener("blur", function () {
                api.__fsEditing = false;
                /* 手机端没有回车键：失焦（点正文/键盘「完成」都触发 blur）= 应用输入值；
                 * 桌面端保持原样（失焦丢弃，回车才应用） */
                if ((api as any).__isMobile) {
                    const v = parseInt((this as HTMLInputElement).value, 10);
                    if (!isNaN(v)) { api.state.fontSize = v; applyFontSize(true); return; }
                }
                applyFontSize(false);
            });
            /* 夜间模式：开关切组件级 b3 变量（工具栏/侧栏/菜单全深色）+ 正文注入夜间样式 */
            const nightBtn = q(".epub-mini__night");
            api.night = false;
            try { api.night = localStorage.getItem("siyuan-epub-night") === "1"; } catch (e) {}
            function nightCssText() {
                return "html,body{background:#1b1c20 !important}" +
                    "body{color:#c9cbd1 !important}" +
                    "body *{text-shadow:none !important}" +
                    "a{color:#8ab4f8 !important}";
            }
            function applyNightToContents(contents: any) {
                try {
                    const doc = contents.document;
                    if (!doc || !doc.head) return;
                    let st = doc.getElementById("epub-mini-night-style");
                    if (!st) { st = doc.createElement("style"); st.id = "epub-mini-night-style"; doc.head.appendChild(st); }
                    st.textContent = api.night ? nightCssText() : "";
                } catch (e) {}
            }
            function applyNight() {
                root.classList.toggle("epub-mini--night", api.night);
                const reg = api.viewRegistry || [];
                for (let i = 0; i < reg.length; i++) applyNightToContents(reg[i].contents);
                try { localStorage.setItem("siyuan-epub-night", api.night ? "1" : "0"); } catch (e) {}
            }
            /* 圆形侵蚀特效（水波纹版，2026-09-29）：每次点击生成一个独立幽灵层
             * （= 目标态快照：真实层此刻仍是被盖住的旧态，克隆它+注入目标样式即为正确快照），
             * 圆从开关圆钮位置扩张；快速连点 = 多层波纹黑白相间依次外推。
             * 结算规则：真实层（夜类 + iframe 夜样式）只在「最新一层」收尾时切换，
             * 中间层目标态已过时、结束时仅自毁；真实层在整个波纹期间保持旧态被盖住，无闪变。 */
            let ghostSeq = 0; // 已发出的波纹计数：只有 seq 相同（= 最新）的层有真实层结算权
            function refreshNightBtn(): void {
                nightBtn.classList.toggle("is-night", api.night);
            }
            /* 浅色变量快照：幽灵层嵌在真实层内部，日向扩张时真实层仍是夜态
             * （root 挂夜类）——「不挂深色修饰类」继承到的仍是深色变量（实测穿帮）。
             * 必须显式刷浅色。抓取惰性：首次日向 buildGhost 时临时摘夜类读取、
             * 立即挂回——同步代码一帧内完成，浏览器不渲染中间态，零闪烁。 */
            let dayVars = "";
            function snapshotDayVars(): void {
                if (dayVars) return;
                try {
                    const hadNight = root.classList.contains("epub-mini--night");
                    if (hadNight) root.classList.remove("epub-mini--night");
                    const cs = getComputedStyle(root);
                    const names = ["--b3-theme-background", "--b3-theme-surface", "--b3-theme-on-surface", "--b3-theme-on-background", "--b3-theme-on-surface-light", "--b3-list-hover", "--b3-border-color", "--b3-theme-primary-lightest", "--b3-theme-primary-lighter", "--b3-menu-background", "--b3-theme-surface-lighter", "--b3-dialog-shadow"];
                    let s = "";
                    for (let i = 0; i < names.length; i++) s += names[i] + ":" + cs.getPropertyValue(names[i]).trim() + ";";
                    dayVars = s;
                    if (hadNight) root.classList.add("epub-mini--night");
                } catch (e) {}
            }
            /* 造一个目标态快照到指定幽灵层 g；返回滚动同步句柄（动画期间每帧镜像真实层
             * scrollTop——epub.js 的补偿/trim 可能正在挪真实层，一次性对齐会残留漂移；
             * 侧栏列表同理：动画期间用户仍能滚真实侧栏（幽灵层 pointer-events:none
             * 不挡），克隆体是一次性对齐的快照，不逐帧跟随就会"钉死"在旧位置） */
            function buildGhost(g: HTMLElement, night: boolean): { gv: HTMLElement, cont: HTMLElement, gs: HTMLElement | null, sb: HTMLElement | null } | null {
                g.innerHTML = "";
                if (night) { // 夜装：深色变量修饰类（g 是新建元素，无内联残留）
                    g.classList.add("epub-mini__ghost--night");
                } else { // 日装：显式浅色内联（优先级高于类/继承，压过夜态真实层传下来的深色变量）
                    snapshotDayVars();
                    g.classList.remove("epub-mini__ghost--night");
                    g.style.cssText = dayVars;
                }
                const tb = root.querySelector(".epub-mini__toolbar").cloneNode(true) as HTMLElement;
                const sb = root.querySelector(".epub-mini__sidebar").cloneNode(true) as HTMLElement;
                const gNight = tb.querySelector(".epub-mini__night");
                if (gNight && night) gNight.classList.add("is-night"); // 快照呈现目标态的开关外观
                g.appendChild(tb);
                g.appendChild(sb);
                /* 克隆正文：把可视章节的整棵文档 DOM 写进幽灵 iframe，幽灵层 = 真内容快照而非黑板子。
                 * 几何不自行堆叠：每章用 getBoundingClientRect 取滚动内容坐标系真值做
                 * absolute 镜像，另垫一块等高于真实 scrollHeight 的普通流垫片
                 *（absolute 子元素不计入 scrollHeight，没有垫片 scrollTop 会归零）。
                 * 动画结束 ghost.innerHTML="" 销毁。 */
                try {
                    const viewer = root.querySelector(".epub-mini__viewer");
                    const cont = viewer ? viewer.querySelector(".epub-container") : null;
                    if (viewer && cont) {
                        const gv = document.createElement("div");
                        gv.className = "epub-mini__ghost-viewer";
                        /* gv 保持 CSS 的 absolute 定位（top:42/bottom:0 固定可视窗口，
                         * overflow:hidden + scrollTop 编程滚动）。absolute 元素天然是
                         * 章块的定位祖先，不要再设 relative——那会废掉固定高度窗口、
                         * 内容全展开（scrollHeight==clientHeight → scrollTop 恒 0）。 */
                        g.appendChild(gv); // 必须先进文档树，iframe 的 contentDocument 才可用
                        const contRect = cont.getBoundingClientRect();
                        const baseTop = contRect.top - cont.scrollTop; // 内容坐标系 y=0 的视口 y
                        let maxBottom = 0;
                        const views = cont.querySelectorAll(".epub-view");
                        for (let i = 0; i < views.length; i++) {
                            const fr = views[i].querySelector("iframe");
                            const srcDoc = fr ? (fr as HTMLIFrameElement).contentDocument : null;
                            if (!srcDoc || !srcDoc.documentElement) continue;
                            const vr = views[i].getBoundingClientRect();
                            const top = vr.top - baseTop; // 该章在滚动内容坐标系里的真实 top
                            const left = vr.left - contRect.left; // 横向同样抄真值
                            const w = vr.width; // 分数真值宽：与真实 iframe 视口（.epub-view 的 100%）严格相等
                            const h = vr.height; // offsetWidth/Height 是取整值，微小宽度差足以让个别段落折行不同
                            /* 宽度必须用真值 px 而非 width:100%：真实 iframe 视口 =
                             * .epub-view 内联 px 宽（epub.js 按容器 clientWidth 算，刨掉了滚动条
                             * 约 17px），而 gv 无滚动条、100% = 面板全宽 → 克隆体比真实层宽 17px：
                             * 图片（max-width:100%）整条放大、全书折行改变 → 内容总高漂移对不上。
                             * 纯文字书只差个别行折行看不出来，带图的书一眼穿帮。 */
                            const block = document.createElement("div");
                            block.style.cssText = "position:absolute;left:" + left + "px;width:" + w + "px;margin:0;top:" + top + "px;height:" + h + "px";
                            const gif = document.createElement("iframe");
                            gif.setAttribute("scrolling", "no");
                            gif.setAttribute("tabindex", "-1");
                            block.appendChild(gif);
                            gv.appendChild(block);
                            if (top + h > maxBottom) maxBottom = top + h;
                            const gdoc = gif.contentDocument as Document;
                            const html = srcDoc.documentElement.cloneNode(true) as HTMLElement;
                            const scripts = html.querySelectorAll("script"); // 克隆体不重放脚本
                            for (let s = 0; s < scripts.length; s++) {
                                if (scripts[s].parentNode) scripts[s].parentNode.removeChild(scripts[s]);
                            }
                            /* ★ CSSOM 回填：cloneNode 只克隆 textContent，不克隆 CSSOM。
                             * epub.js 的 adjustImages 与主题规则都走 addStylesheetRules
                             * → 空 <style> + insertRule，textContent 恒为空 → 克隆体里这些
                             * <style> 是空壳，图片钳制全部蒸发（真实层钳到 ~734px，克隆体按
                             * 书内 max-width:100% 撑到 ~805px）。按序把原文档每条空文本
                             * <style> 的 CSSOM 规则序列化回填给克隆体对应元素。 */
                            try {
                                const srcStyles = srcDoc.querySelectorAll("style");
                                const dstStyles = html.querySelectorAll("style");
                                for (let s = 0; s < srcStyles.length && s < dstStyles.length; s++) {
                                    const sheet = srcStyles[s].sheet as CSSStyleSheet | null;
                                    if (!sheet) continue;
                                    if ((dstStyles[s].textContent || "").trim() !== "") continue; // 文本内联的已随节点克隆
                                    let txt = "";
                                    try {
                                        const rules = sheet.cssRules;
                                        for (let r = 0; r < rules.length; r++) txt += rules[r].cssText + "\n";
                                    } catch (e) { continue; } // 跨源 sheet 读不了则跳过
                                    if (txt) dstStyles[s].textContent = txt;
                                }
                            } catch (e) {}
                            /* ★ 图片盒子钉死：克隆 iframe 里的 <img> 是异步重载的，排版随加载波动 → 视口上方
                             * 有图的章节正文亚行级漂移（纯文字章节无感）。把原文档每张图
                             * 当前真实渲染盒以内联 !important 钉给克隆体，克隆布局在克隆
                             * 瞬间冻结为真值。 */
                            try {
                                const srcImgs = srcDoc.querySelectorAll("img");
                                const dstImgs = html.querySelectorAll("img");
                                for (let s = 0; s < srcImgs.length && s < dstImgs.length; s++) {
                                    const box = srcImgs[s].getBoundingClientRect();
                                    if (box.width === 0 && box.height === 0) continue; // 真实层尚未布局的（极少）不钉，随其自然加载
                                    dstImgs[s].style.setProperty("width", box.width + "px", "important");
                                    dstImgs[s].style.setProperty("height", box.height + "px", "important");
                                }
                            } catch (e) {}
                            /* ★ DOCTYPE 保真：iframe 初始 about:blank 是怪异模式（实测），
                             * 而 compatMode 在文档创建时定死、事后改不了（DOCTYPE 是
                             * documentElement 的兄弟节点，replaceChild 挂不过去）。
                             * 怪异模式下 inline 图片行盒不保留字体下降部空隙（约 5px）
                             * → 多图章节累积成大错位、无图章节完美对齐（实测 div.tupian
                             * 真实层 200.14 vs 克隆体 195.14）。对策：document.write
                             * 全量重建文档。 */
                            gdoc.open();
                            gdoc.write("<!DOCTYPE html>" + html.outerHTML);
                            gdoc.close();
                            if (night) { // 夜向：真实层此刻是日态 → 克隆体补夜样式
                                const st = gdoc.createElement("style");
                                st.textContent = nightCssText();
                                const head = gdoc.head || gdoc.querySelector("head");
                                if (head) head.appendChild(st);
                            } else { // 日向：真实层此刻是夜态 → 克隆体天生带夜样式，摘掉（清空注入的 night-style）
                                const nst = gdoc.getElementById("epub-mini-night-style");
                                if (nst) nst.textContent = "";
                            }
                        }
                        /* 垫片：普通流元素，高度=真实内容总高，撑起 gv.scrollHeight；
                         * absolute 章块不计入滚动高度，无垫片时 scrollTop 恒为 0。 */
                        const spacer = document.createElement("div");
                        spacer.style.cssText = "position:relative;width:0;height:" + Math.max(maxBottom, cont.scrollHeight) + "px";
                        gv.appendChild(spacer);
                        /* display:none 子树无布局 → 此时赋 gv.scrollTop 会被静默吞成 0。
                         * 先强制显示再对齐滚动。 */
                        g.style.display = "block";
                        gv.scrollTop = cont.scrollTop; // 对齐滚动位置（几何全为真值镜像）
                        /* cloneNode 不克隆滚动位置（scrollTop 是布局状态不是属性）：
                         * 目录/标注列表滚到中部时克隆体从 0 开始，幽灵层侧栏显示的是
                         * 列表开头（刚打开时看到的部分）而非当前视口 → 手工回抄。 */
                        const sbContent = sb.querySelector(".epub-mini__sidebar-content") as HTMLElement | null;
                        const srcContent = root.querySelector(".epub-mini__sidebar-content") as HTMLElement | null;
                        if (sbContent && srcContent) sbContent.scrollTop = srcContent.scrollTop;
                        return { gv: gv, cont: cont, gs: sbContent, sb: srcContent }; // 之后每帧跟随真实层滚动（正文+侧栏）
                    }
                } catch (e) {}
                return null;
            }
            function ghostOrigin(): { cx: number, cy: number, fullR: number } {
                const rr = root.getBoundingClientRect();
                const br = nightBtn.getBoundingClientRect();
                const cx = br.left - rr.left + br.width / 2;
                const cy = br.top - rr.top + br.height / 2;
                const fullR = Math.hypot(Math.max(cx, rr.width - cx), Math.max(cy, rr.height - cy));
                return { cx: cx, cy: cy, fullR: fullR };
            }
/* 发一道波纹：新建幽灵层（目标态快照）+ 圆从开关位置扩张。旧波纹不取消，只有最新
 * 一层有结算权，中间层停在全覆盖态当底色（pointer-events:none）由最新层统一清扫
 * —— 提前退场会让最新波纹失去对比并露出同色真实层造成瞬切穿帮。
 * 移动端阀门：叠多个「iframe 全文档克隆 + clip-path 逐帧重绘」会打爆 GPU，发新波纹前
 * 把旧波纹快进定格成底色板，活动画层恒 ≤1。 */
            const activeRipples = new Set<{ frozen: boolean; g: HTMLElement; o: { cx: number; cy: number; fullR: number } }>();
            function spawnRipple(): void {
                const seq = ++ghostSeq;
                const target = api.night;
                const o = ghostOrigin();
                const dur = 1500; // 圆形扫过全面板的时长
                const t0 = performance.now();
                const g = document.createElement("div");
                g.className = "epub-mini__ghost";
                root.appendChild(g); // 后发的波纹天然叠在上层（水波纹的层序即 DOM 顺序）
                const sync = buildGhost(g, target);
                g.style.clipPath = "circle(0px at " + o.cx + "px " + o.cy + "px)";
                const handle = { frozen: false, g: g, o: o };
                if (api.__isMobile) { // 快进旧波纹：停循环 + 定格全覆盖（中间层本就无结算权，语义不变）
                    activeRipples.forEach(function (r) {
                        r.frozen = true;
                        r.g.style.clipPath = "circle(" + r.o.fullR + "px at " + r.o.cx + "px " + r.o.cy + "px)";
                    });
                    activeRipples.clear();
                }
                activeRipples.add(handle);
                const step = function (now: number) {
                    if (handle.frozen) return; // 被快进：定格为底色板，动画循环终止
                    if (sync) sync.gv.scrollTop = sync.cont.scrollTop; // 逐帧镜像真实层滚动（补偿/trim 可能正在挪它）
                    if (sync && sync.gs && sync.sb) sync.gs.scrollTop = sync.sb.scrollTop; // 侧栏列表同帧跟随（动画期间用户可滚真实侧栏）
                    const k = Math.min((now - t0) / dur, 1);
                    const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
                    g.style.clipPath = "circle(" + (o.fullR * e) + "px at " + o.cx + "px " + o.cy + "px)";
                    if (k < 1) {
                        requestAnimationFrame(step);
                    } else {
                        activeRipples.delete(handle);
                        if (seq === ghostSeq) { // 最新层：结算真实层 + 清扫全部停驻旧层
                            /* 冻结过渡一拍：结算翻转 CSS 变量时，工具栏按钮的 hover 过渡
                             * （toc-btn background .15s / night toggle .2s 等）会把"旧色→新色"
                             * 播成可见的变色动画 = 幽灵层摘掉后按钮闪一下。冻结期间变量
                             * 直接落到终值，两拍后恢复，hover 过渡照常。 */
                            root.classList.add("epub-mini--settle");
                            root.classList.toggle("epub-mini--night", api.night);
                            applyNight(); // iframe 夜间样式 + localStorage（此处幂等）
                            root.querySelectorAll(".epub-mini__ghost").forEach(function (el: Element) { el.remove(); });
                            requestAnimationFrame(function () {
                                requestAnimationFrame(function () { root.classList.remove("epub-mini--settle"); });
                            });
                        }
                        // 中间层：不结算不退场，停驻全覆盖态给最新波纹当底色
                    }
                };
                requestAnimationFrame(step);
            }
            refreshNightBtn(); // 恢复上次夜间状态时同步旋钮太阳/月亮
            nightBtn.addEventListener("click", function (ev: MouseEvent) {
                ev.stopPropagation();
                /* 手机端锁：动画期间禁切（用户定 2026-09-29）。手机上连点本就会快进旧波纹
                 * （GPU 保护），与其"点了但看到旧动画瞬间定格"，不如干脆不响应——
                 * activeRipples 在手机端动画期间恒含 1 个活动波纹、收尾即删，天然是锁标志。
                 * 桌面端不设限，完整水波纹照旧。 */
                if (api.__isMobile && activeRipples.size > 0) return;
                api.night = !api.night;
                refreshNightBtn();
                spawnRipple();
                if ((pageTip as HTMLElement).style.display === "block") showTip(nightBtn); // 悬停中切换 → 提示同步
            });
            nightBtn.addEventListener("mouseenter", function () { showTip(nightBtn); });
            nightBtn.addEventListener("mouseleave", function () { (pageTip as HTMLElement).style.display = "none"; api.__tipAnchor = null; });
            /* 作者卡片：定位在作者按钮下方（右对齐 + 小箭头指向按钮），点外部/Esc 收起 */
            const authorBtn = q(".epub-mini__author-btn");
            const authorCard = root.querySelector(".author-card");
            const avatarImg = authorCard.querySelector(".author-card__avatar") as HTMLImageElement | null;
            if (avatarImg) avatarImg.addEventListener("error", function () { // 断网/头像 404 → 「于」字圆形占位
                try {
                    const d = document.createElement("div");
                    d.className = "author-card__avatar-fallback";
                    d.textContent = "于";
                    avatarImg.replaceWith(d);
                } catch (e) {}
            });
            function closeAuthorCard(): void { authorCard.classList.remove("show"); }
            authorBtn.addEventListener("click", function (ev: MouseEvent) {
                ev.stopPropagation();
                if (authorCard.classList.contains("show")) { closeAuthorCard(); return; }
                const btnRect = authorBtn.getBoundingClientRect();
                const rootRect = root.getBoundingClientRect();
                const cardW = 250;
                let left = btnRect.right - rootRect.left - cardW;
                if (left < 8) left = 8;
                authorCard.style.left = left + "px";
                authorCard.style.top = "48px";
                authorCard.style.setProperty("--arrow-x", ((btnRect.left - rootRect.left) - left + btnRect.width / 2) + "px");
                authorCard.classList.add("show");
            });
            /* 点卡片外任意处收起：document 捕获阶段监听，覆盖工具栏/侧栏/正文缝隙全区域
             * （原 root 冒泡监听收不到 iframe 内部点击，那部分由 rendered 钩子补） */
            const docClose = function (ev: MouseEvent) {
                if (!authorCard.classList.contains("show")) return;
                const tgt = ev.target as Node;
                if (authorCard.contains(tgt) || authorBtn.contains(tgt)) return;
                closeAuthorCard();
            };
            document.addEventListener("click", docClose, true);
            /* 标注面板：点主文档区域（工具栏/侧栏/页签头）也收起。
             * iframe 内部点击由 bindMarkClick 收（那里有 contents 上下文），
             * 但 iframe 里的事件冒泡不出 iframe，主文档这条是唯一兜底。
             * 捕获阶段 + contains 排除：面板自身的按钮（色块/复制/移除）必须
             * 照常生效，不能被这条监听抢先关掉。 */
            const utilBox = q(".epub-mini__util") as HTMLElement;
            const utilClose = function (ev: MouseEvent) {
                if (!isUtilVisible(api)) return;
                if (utilBox && utilBox.contains(ev.target as Node)) return;
                closeUtil(api);
            };
            document.addEventListener("click", utilClose, true);
            /* window 级兜底「已松手」标记：指针在 iframe 里按下、在外面松开时 iframe 收不到
             * mouseup/touchend → 标记永久卡 false → 面板再也不弹（短距离选词全程在
             * iframe 内所以照常弹，这就是「有时候」的来源）。覆盖：主文档松手 / 拖出
             * 窗口 / 失焦 / HTML5 drag 打断；capture 阶段确保抢在气泡前。 */
            const settleWin = function (ev: any) {
                settleAllViews(api, ev && ev.type);
            };
            // 按下也要在 window 级留个记号：兜底定时器据此区分「还在犹豫」与「抬起事件丢了」
            const downWin = function () { (api as any).__pointerDown = true; };
            window.addEventListener("mouseup", settleWin, true);
            window.addEventListener("touchend", settleWin, true);
            window.addEventListener("touchcancel", settleWin, true);
            // pointer 事件鼠标/触屏/手写笔通吃，且与思源 asset/anno.ts 的处理口径一致
            window.addEventListener("pointerup", settleWin, true);
            window.addEventListener("pointercancel", settleWin, true);
            window.addEventListener("dragend", settleWin, true);
            window.addEventListener("blur", settleWin, true);
            window.addEventListener("pointerdown", downWin, true);
            window.addEventListener("mousedown", downWin, true);
            window.addEventListener("touchstart", downWin, true);
            panel.addEventListener("keydown", function (ev: KeyboardEvent) {
                if (ev.key === "Escape") closeAuthorCard();
                /* Tab 不在此处处理：由 document 捕获监听统一接管（焦点在页签头/主文档也要能响应） */
            });
            /* 外部链接：siyuan API → electron shell → window.open 三级兜底（不打断阅读器） */
            function openExternal(url: string): void {
                try {
                    if (window.siyuan && typeof window.siyuan.openExternal === "function") { window.siyuan.openExternal(url); return; }
                } catch (e) {}
                try {
                    if (window.require) {
                        const shell = window.require("electron").shell;
                        if (shell && shell.openExternal) { shell.openExternal(url); return; }
                    }
                } catch (e) {}
                window.open(url, "_blank", "noopener,noreferrer");
            }
            authorCard.querySelectorAll("[data-url]").forEach(function (el: Element) {
                el.addEventListener("click", function (ev: MouseEvent) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    openExternal(el.getAttribute("data-url"));
                });
            });
            /* 二维码舞台：悬停 80ms 放大居中，离开整个舞台 150ms 后复位（防划过误触发）。
             * 收起不能挂在单个码的 mouseleave 上：格子热区恒 96px，放大的 img 视觉上溢出格子，
             * 鼠标停在溢出区会触发「收起→复位→再入热区→放大」的死循环抖动。 */
            const qrStage = authorCard.querySelector(".author-qrcodes-stage");
            const qrTimers = { enter: 0, leave: 0 };
            authorCard.querySelectorAll("[data-qr]").forEach(function (qr: Element) {
                (qr as HTMLElement).addEventListener("mouseenter", function () {
                    clearTimeout(qrTimers.leave);
                    const name = (qr as HTMLElement).getAttribute("data-qr");
                    if (qrStage.getAttribute("data-active") === name) return;
                    clearTimeout(qrTimers.enter);
                    qrTimers.enter = window.setTimeout(function () { qrStage.setAttribute("data-active", name); }, 80);
                });
            });
            qrStage.addEventListener("mouseenter", function () { clearTimeout(qrTimers.leave); }); // 在两码间移动/停在间隙不收起
            qrStage.addEventListener("mouseleave", function () {
                clearTimeout(qrTimers.enter);
                qrTimers.leave = window.setTimeout(function () { qrStage.removeAttribute("data-active"); }, 150);
            });
            // 点击正文区域（iframe 外缝隙）也收侧栏
            host.addEventListener("click", function () {
                root.classList.remove("epub-mini--sidebar-open");
            });
            // 选中菜单按钮：无背景模式 / 复制 / 移除高亮（点弹层空白处收起）
            const util = q(".epub-mini__util");
            function updateToggleBtn() {
                const tb = util.querySelector('[data-util="toggle"]');
                if (tb) tb.classList.toggle("epub-mini__toggle-on", api.state.annoMode === "border");
            }
            util.addEventListener("click", function (ev: MouseEvent) {
                const btn = (ev.target as HTMLElement).closest && (ev.target as HTMLElement).closest("[data-util]");
                if (!btn) { this.classList.add("fn__none"); return; }
                const u = btn.getAttribute("data-util");
                if (u === "toggle") {
                    // 常驻模式开关：无背景(border) ↔ 有背景(text)，点一次记住，后续标注沿用
                    const mode = api.state.annoMode === "border" ? "text" : "border";
                    api.state.annoMode = mode;
                    if (api.selMark) api.selMark.type = mode; // 当前选中标注同步切换
                    saveState(api); restoreMarks(api);
                    updateToggleBtn();
                } else if (u === "copy") {
                    if (api.selMark) {
                        copyText(buildMarkRef(api, api.selMark));
                        showToast(api, "已复制标注引用，粘贴到文档即可点击跳转");
                    } else if (api.selText && navigator.clipboard) navigator.clipboard.writeText(api.selText);
                } else if (u === "remove" && api.selCfi) {
                    removeIntersectingMarks(api, api.selCfi, api.selContents);
                    saveState(api); renderMarkList(api); restoreMarks(api);
                }
                this.classList.add("fn__none");
            });
            /* 内核对 /assets/*.epub 的大文件 gzip 响应体会被截断（浏览器必带
             * Accept-Encoding，curl 不带所以只在浏览器端暴露），epub.js 拿到
             * 残缺字节必然报「不是 zip」。fetchBookBytes 负责整取校验 +
             * 分块重取 + gzip 解压。 */
            setLoadTip("正在读取书籍", true);
            fetchBookBytes(assetURL(path)).then(function (bytes: ArrayBuffer) {
                api.__bookBytes = bytes.byteLength; // 供 progressFingerprint 判「这本书换了没」
                book = ePub(bytes);
                startReader();
            }).catch(function (err: any) {
                const why = (err && err.message) || "未知错误";
                console.error("[EPUB-MINI] 取书字节失败:", why, err);
                setLoadTip(/HTTP 40[34]/.test(why)
                    ? "书籍文件已被删除或不存在，无法打开"
                    : "书籍读取失败（网络传输不完整，已重试）", false);
            });
            function startReader() {
                try {
                /* 书文件 404（已删除/不在）→ epub.js 的 opened promise reject 且无人接住
                 * → book.ready 永不 resolve → 界面永远停在「EPUB 加载中…」。
                 * 接住后二次探测区分失败原因（GET+Range 探测，HEAD 在内核不可靠，
                 * 同 pruneOrphanAnnotations 的教训）：404/403 = 文件不在；否则 = 损坏/解析失败。 */
                book.opened.then(function () {}, function (err: any) {
                    /* err 原来被整体丢弃，无法定位（message 形如
                     * "Cannot load book at <url>: <原因>"）——先打进控制台再分层 */
                    console.error("[EPUB-MINI] opened reject:", err && err.status, err && err.message);
                    /* 二次探测区分失败原因（GET+Range 探测，HEAD 在内核不可靠，
                     * 同 pruneOrphanAnnotations 的教训）：404/403 = 文件不在；
                     * 401 = 思源 3.8.5 起未授权请求被拒（访问授权码/来源校验）；
                     * 其余 = 损坏/解析失败。 */
                    fetch(assetURL(path), { headers: { Range: "bytes=0-0" } }).then(function (p: Response) {
                        let msg: string, tocMsg: string;
                        if (p.status === 404 || p.status === 403) {
                            msg = "书籍文件已被删除或不存在，无法打开";
                            tocMsg = "书籍已删除，无法打开";
                        } else if (p.status === 401) {
                            msg = "思源拒绝了访问（401），请检查设置→关于的访问授权码";
                            tocMsg = "访问被拒绝（401）";
                        } else {
                            msg = "书籍打开失败，文件可能已损坏";
                            tocMsg = "书籍打开失败";
                        }
                        setLoadTip(msg, false);
                        const tocHost = root.querySelector(".epub-mini__pane--toc");
                        if (tocHost) tocHost.innerHTML = '<div class="epub-mini__toc-empty">' + tocMsg + "</div>";
                    }).catch(function () {
                        setLoadTip("书籍打开失败，无法读取书籍文件", false);
                    });
                });
                // 连续滚动模式：滚轮滚动时自动加载上下章节
                rend = book.renderTo(host, {
                    manager: "continuous",
                    flow: "scrolled",
                    width: "100%", height: "100%",
                    spread: "none",
                    allowScriptedContent: false
                });
                api.book = book;
                api.rend = rend;
                /* ★ 队列守卫必须在任何 display 之前装好：epub.js 队列续命链无 catch，任务同步抛错就
                 * 永久停摆（running 卡 true、promise 永不 settle）—— 那是「正文空白」与
                 * 「点什么都没用」的共同底座。装晚了首屏 display 已经进死队列。 */
                installQueueGuards(api);
                // 新章节视图：同步夜间样式 + 字号（每个 section 渲染时触发）
                try {
                    rend.hooks.content.register(function (contents: any) {
                        applyNightToContents(contents);
                        try { if (api.state.fontSize) contents.document.documentElement.style.fontSize = api.state.fontSize + "px"; } catch (e) {}
                    });
                } catch (e) {}
                if (api.night) applyNight(); // 恢复上次夜间状态（全局记忆）
                applyFontSize(false);        // 恢复字号（随书记忆）
                // 滚动时同步高亮目录 + 页码指示
                rend.on("relocated", function (location: any) {
                    const href = location && location.start && location.start.href;
                    highlightTOC(api, href);
                    if (api.updatePageInfo) api.updatePageInfo();
                    // 顺带记录阅读进度（纯数据：只读当前 cfi + 写盘，不碰几何）
                    // relocated 是滚动时的天然钩子，无需另挂监听器
                    if (api.__progressArmed && !isJumping(api)) {
                        const now = Date.now();
                        if (now - (api.__lastProgressAt || 0) > PROGRESS_SAVE_GAP) {
                            api.__lastProgressAt = now;
                            try {
                                api.state.progress = { fp: progressFingerprint(api), cfi: location.start.cfi, at: now };
                                saveState(api);
                            } catch (e) {}
                        }
                    }
                });
                // 选中文字 → 弹出标注菜单（颜色 / 复制 / 移除）
                /* epub.js 的 selected 走 selectionchange+250ms 防抖，而 selectionchange
                 * 在**拖动过程中**就会连发 —— 拖得稍慢或中途停顿超 0.25s 就会提前弹出。
                 * 判据改为「指针已抬起」：拖动中不弹，松手后的正常选中照常弹。 */
                rend.on("selected", function (cfiRange: string, contents: any) {
                    /* selected 的语义是「选区 250ms 没变化」，**与是否松手无关**
                     * （源码 Contents.onSelectionChange）。拖动中先存票，等 pointerup
                     * 兑现 —— 直接 return 会把这唯一一次机会丢掉，面板就永不弹了；
                     * 已松手则直接排弹出（顺带覆盖 Ctrl+A 这类没有指针抬起的选中）。 */
                    let text = "";
                    try { text = contents.window.getSelection().toString(); } catch (e) {}
                    if (!isSelectionSettled(contents)) {
                        deferSelection(api, contents, cfiRange, text, "selected-拖动中");
                        return;
                    }
                    scheduleSelectionPanel(api, contents, false, { cfi: cfiRange, text: text }, "selected");
                });
                // 每章渲染后：立即收「加载中」提示（rendered = 内容真正画出来的瞬间，零延迟）
                // + 注册视图/重绘标注覆盖层/绑标注点击 + 滚动兜底（幂等）+ 主动级联预加载
                rend.on("rendered", function (section: any, view: any) {
                    hideTip();
                    registerView(api, section, view && view.contents);
                    if (view && view.contents) {
                        restoreMarksForView(api, section, view.contents);
                        bindMarkClick(api, section, view.contents);
                        try { // iframe 内点正文 → 收起作者卡片（iframe 事件不冒泡到宿主 document，须单独挂钩）
                            const ibody = view.contents.document.body as any;
                            if (ibody && !ibody.__ymerCardClose) {
                                ibody.__ymerCardClose = true;
                                ibody.addEventListener("click", function () { closeAuthorCard(); });
                            }
                        } catch (e) {}
                    }
                    bindScrollChapters(api);
                    if (api.__ensureBottomLoaded) { try { api.__ensureBottomLoaded(); } catch (e) {} }
                });
                // 容器尺寸变化（窗口缩放/分屏拖动/侧栏开合）→ 重排，内容随窗口动态调节
                if (window.ResizeObserver) {
                    let roTimer: any = null;
                    const ro = new ResizeObserver(function () {
                        clearTimeout(roTimer);
                        roTimer = setTimeout(function () { resizeRendition(api); }, 180);
                    });
                    ro.observe(host);
                }
                // continuous 管理器对 display(undefined) 不渲染任何视图（实测），
                // 必须 book.ready 后给具体章节目标；顺便构建目录侧栏
                book.ready.then(function () {
                    const tocHost = root.querySelector(".epub-mini__pane--toc");
                    try {
                        const toc = (book.navigation && book.navigation.toc) || [];
                        tocHost.innerHTML = toc.length ? "" : '<div class="epub-mini__toc-empty">本书无目录</div>';
                        if (toc.length) renderTOC(api, toc, 0, tocHost);
                    } catch (e) { tocHost.innerHTML = '<div class="epub-mini__toc-empty">目录解析失败</div>'; }
                    renderMarkList(api); // 标注列表（含历史标注）
                    /* 页码定位点：优先工作空间缓存（跨重启 / 跨设备），无缓存才后台生成 1024 字/页。
                     * localStorage 只当镜像兜底 —— 思源前端 origin 是随机端口、按 origin
                     * 隔离 → 重启必失效，存它会导致每次都重算全书页码。 */
                    (function () {
                        const locKey = "siyuan-epub-loc:" + path;
                        let fp: string | null = null;
                        try {
                            fp = book.spine.items.length + ":" + (book.spine.items[0] ? book.spine.items[0].href : "");
                            /* 主存储 = 工作空间 state；镜像 = localStorage（后者跨重启失效，仅兜底） */
                            const fromState = api.state && api.state.locations;
                            const mirrored = (function () { try { return JSON.parse(localStorage.getItem(locKey) || "null"); } catch (e0) { return null; } })();
                            const cached = (fromState && fromState.fp === fp) ? fromState : mirrored;
                            const mirroredHit = cached === mirrored && !!mirrored;
                            /* 有效性只认「非空」：locations.save() 返回 JSON 字符串，
                             * 旧代码卡 length>10 / 数组>2 会让**内容极少的小书**缓存恒被判无效、
                             * 每次打开都重算（实测 1 个锚点的书 locs 长度仅 9）。这里放宽为「有内容即可」，
                             * 真正的有效性由 fp 指纹把关（换书必重算）。 */
                            const locsOk = cached && cached.fp === fp && cached.locs &&
                                (Array.isArray(cached.locs) ? cached.locs.length > 0
                                    : (typeof cached.locs === "string" && cached.locs.length > 2));
                            if (locsOk) {
                                book.locations.load(cached.locs);
                                api.locTotal = (book.locations.total || 0) + 1;
                                if (api.updatePageInfo) api.updatePageInfo();
                                /* 命中镜像（说明主存储还没有）→ 回填工作空间，下次重启即可秒出 */
                                if (mirroredHit) {
                                    api.state.locations = { fp: fp, locs: cached.locs };
                                    saveState(api);
                                }
                                return; // 缓存命中，无需生成
                            }
                        } catch (e) {}
                        setTimeout(function () {
                            try {
                                if (api.book && api.book.locations && api.book.locations.generate) {
                                    api.book.locations.generate(1024).then(function () {
                                        api.locTotal = (api.book.locations.total || 0) + 1; // total=末索引，页数=索引+1
                                        if (api.updatePageInfo) api.updatePageInfo();
                                        try {
                                            const fp2 = api.book.spine.items.length + ":" + (api.book.spine.items[0] ? api.book.spine.items[0].href : "");
                                            const payload = { fp: fp2, locs: api.book.locations.save() };
                                            api.state.locations = payload;   // 主存储：工作空间 JSON
                                            saveState(api);                   // 立即落盘（不必等防抖）
                                            try { localStorage.setItem(locKey, JSON.stringify(payload)); } catch (e2) {} // 镜像
                                        } catch (e2) {}
                                    });
                                }
                            } catch (e) {}
                        }, 1200);
                    })();
                    const first = book.spine && book.spine.first();
                    const firstHref = first ? first.href : undefined;
                    installGuard(api); // display 守卫（幂等）：拦 epub.js 内部自回位（onResized 等拿滞后 location 重显示）
                    // 书首首屏也走统一意图通道（不再裸调 rend.display）：它与稍后到达的
                    // 标注跳转天然串行——若用户在意图稳定窗内点了标注，书首这个意图会被
                    // 直接覆盖，省下一次 iframe 重建。
                    api.__want = firstHref;
                    api.__booted = true; // 装配完成标志：jumpToCfi 轮询据此接上跳转入口
                    if (firstHref) requestJump(api, firstHref);
                    else console.warn("[yumin-ebook-reader] spine 为空，无首屏目标（交给 fixup 兜底）");
                    /* 恢复上次阅读位置（延迟到首屏意图落地之后）
                     * 走标准 requestJump → last-write-wins 天然收编：用户在下面
                     * 1.4s 内点了目录/标注，会直接覆盖本意图，不会被强行拉回。
                     * 两个守卫：
                     *   __jumpSeq > 1  = 除开书首屏外还发生过跳转 = 用户有明确意图，不打扰
                     *   fp 不匹配      = 书内容变了，旧 cfi 已失效，丢弃 */
                    setTimeout(function () {
                        api.__progressArmed = true;   // 武装后才开始记录（见下）
                        if (!root.isConnected) return;
                        const pg = api.state.progress;
                        if (!pg || !pg.cfi) return;
                        if (pg.fp !== progressFingerprint(api)) { console.log("[PROG] 指纹不符，丢弃旧进度"); return; }
                        if ((api.__jumpSeq || 0) > 1) { console.log("[PROG] 用户已自己跳转，跳过恢复"); return; }
                        console.log("[PROG] 恢复到 " + String(pg.cfi).slice(0, 60));
                        requestJump(api, pg.cfi);
                    }, PROGRESS_RESTORE_DELAY);
                    /* 进度记录从「恢复窗口结束后」才武装（api.__progressArmed）：
                     * 否则开书首屏的 relocated 会把「书首 cfi」记下来、覆盖掉上次
                     * 读到的位置——每次开书进度都退化成第一页。 */
                    // epub.js open 竞态：首次 display 可能「空转 resolve 而 views=0」（实测 Chrome 150，
                    // 表现为一直「加载中」）→ 轮询视图数兜底；提示收起由 rendered 事件负责
                    let tries = 0, zeroTicks = 0;
                    const fixup = function () {
                        try {
                            if (!root.isConnected) return; // 页签已关闭：停止巡检
                            if (isJumping(api)) { setTimeout(fixup, 600); return; } // 跳转活动中：门闸关闭，绝不插手
                            const vs = rend.manager && rend.manager.views;
                            const n = vs && vs.all ? vs.all().length : 0;
                            if (n > 0 && root.querySelector(".epub-mini__viewer iframe")) return; // 健康即停
                            if (++tries > 60) { setLoadTip("EPUB 渲染未完成，请关闭页签重开", false); return; }
                            if (++zeroTicks % 3 === 0) { // ≈ 每 1.8s 补一次，避免密集轰炸
                                // 重新登记意图（瞄准 __want），走统一通道而非裸调 display：
                                // 与用户跳转共用同一串行队列，谁也不会顶掉谁
                                console.log("[FIXUP] 重新登记意图(__want=" + String(api.__want).slice(0, 60) + ") views=" + n);
                                if (api.__want) requestJump(api, api.__want);
                            }
                            setTimeout(fixup, 600);
                        } catch (e) {}
                    };
                    setTimeout(fixup, 400);
                });
            } catch (err: any) {
                console.error("[EPUB-MINI] 装配阅读器失败:", err && err.message);
                setLoadTip("EPUB 打开失败：" + (err && err.message ? err.message : err) + "", false);
            }
            }
        const destroy = function () {
            /* 关页签前落盘最后一次阅读进度：saveState 有 800ms 防抖，
             * 不 flush 的话「刚滚到某处就关页签」会丢这一条 */
            try {
                if (api.state.progress) { saveState(api); flushState(); }
            } catch (e) {}
            try { rend && rend.destroy(); } catch (e) {}
            try { book && book.destroy(); } catch (e) {}
            try { document.removeEventListener("click", docClose, true); } catch (e) {}
            try { document.removeEventListener("click", utilClose, true); } catch (e) {}
            try {
                window.removeEventListener("mouseup", settleWin, true);
                window.removeEventListener("touchend", settleWin, true);
                window.removeEventListener("touchcancel", settleWin, true);
                window.removeEventListener("pointerup", settleWin, true);
                window.removeEventListener("pointercancel", settleWin, true);
                window.removeEventListener("dragend", settleWin, true);
                window.removeEventListener("blur", settleWin, true);
                window.removeEventListener("pointerdown", downWin, true);
                window.removeEventListener("mousedown", downWin, true);
                window.removeEventListener("touchstart", downWin, true);
            } catch (e) {}
            try { // Tab 快捷键注册表摘除本阅读器
                const regs: any[] = (window as any).__ymerEpubTabs || [];
                const i = regs.indexOf(regEntry);
                if (i > -1) regs.splice(i, 1);
            } catch (e) {}
        };
        return { api: api, rend: rend, book: book, destroy: destroy };
}

/* 桌面端打开：思源页签（手机端走 mobile.ts 的全屏层，分流在 open.ts） */
export function openEpubDesktop(path: string, split: boolean, onReady?: (tab: any) => void) {
    const exist = findEpubTab(path);           // 已开过 → 直接切过去（无需读状态）
    if (exist) {
        try { exist.parent.switchTab(exist.headElement); } catch (e) {}
        if (onReady) onReady(exist);           // 标注引用跳转等后续操作在此拿到页签
        return exist;
    }
    // 标注/进度存于插件数据目录（随思源同步），异步取到后再建页签
    loadStateAsync(path).then(function (state: ReaderState) {
        openDesktopWithState(path, split, state, onReady);
    });
    return null;
}

function openDesktopWithState(path: string, split: boolean, state: ReaderState, onReady?: (tab: any) => void) {
    const TabClass = getTabClass();
    const wnd = getActiveWnd();
    if (!TabClass || !wnd) { console.warn("[EPUB-MINI]", "拿不到 Tab 类 / 活动Wnd"); return; }

    let w: { api: ReaderApi; rend: any; book: any; destroy: () => void } | null = null;
    const tab = new TabClass({
        icon: "iconFile",
        title: displayName(path),
        panel: readerHTML(path),
        callback: function (t: any) {
            w = wireReader(t.panelElement, path, state);
            t.__api = w.api;
            setTimeout(function () { t.panelElement.focus(); }, 100);
        }
    });
    tab.model = {
        parent: tab, type: "epub",
        destroy: function () { try { w && w.destroy(); } catch (e) {} },
        send: function () {}
    };
    // 分屏策略（同 editor/util.ts:288 wnd.split("lr").addTab(tab)）：
    // 右侧已有分屏 → 加到右边第一个 Wnd；没有 → 新开一栏
    let target = wnd;
    if (split) {
        const dir = "lr";
        let tgt: any = null;
        const p = wnd.parent;
        if (p && isLayout(p) && p.children.length > 1 && p.direction === dir) {
            const idx = p.children.indexOf(wnd);
            if (idx > -1) {
                let nx = p.children[idx + 1];
                if (!nx) nx = wnd;
                while (isLayout(nx)) nx = nx.children[0];
                tgt = nx;
            }
        }
        if (tgt) {
            tgt.addTab(tab, false, false);
            target = tgt;
        } else {
            const nw = wnd.split(dir);
            nw.addTab(tab, false, false);
            target = nw;
        }
    } else {
        wnd.addTab(tab, false, false);       // isSaveLayout=false，不写布局 JSON
    }
    try { target.switchTab(tab.headElement); } catch (e) {}
    try { target.showHeading && target.showHeading(); } catch (e) {}
    if (onReady) onReady(tab);               // 页签已就位（jumpToCfi 轮询 rend 就绪后定位）
    // 补上 addTab(isSaveLayout=false) 跳过的页签条透明类，避免新分屏顶栏白底
    refreshWndHeaderState();
    setTimeout(refreshWndHeaderState, 350);  // 布局动画结束后再校准一次
    return tab;
}
