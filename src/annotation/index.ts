/* 标注系统：自绘 SVG 覆盖层。epub.js 自带的 annotations 在嵌入环境下注入静默失效，
 * 故走 contents.range(cfi) → DOM Range → client rects → 自画 <svg><rect>，
 * 重绘时机 = rendered（含 resize 后 re-render）。 */
import { saveState, HL_COLORS } from "../state";
import { escapeHTML, svg, copyText, showToast } from "../util";
import { buildMarkRef } from "../markref";
import { bindHorizontalSwipe } from "../gesture";
import { jumpApi } from "../chapters";
import { cfiSpineIndex, registerView, findView, clearAllSelections, viewForCfi } from "./views";
import { rangesIntersect, rangesTouch, mergeRects } from "./rects";
import type { ReaderApi, MarkItem } from "../types";

/* ---------- 统一跳转：display + 清 ignore 闩锁 + 补回下一章保视图链 ---------- */
/* 注：jumpApi 在 chapters.ts（此处 re-export 保持兼容导入面） */

export function removeIntersectingMarks(api: ReaderApi, selCfi: string, preferContents?: any): number {
    const parsed = viewForCfi(api, selCfi, preferContents);
    if (!parsed) {
        const before = (api.state.marks || []).length;
        api.state.marks = (api.state.marks || []).filter(function (x) { return x.cfi !== selCfi; });
        return before - api.state.marks.length;
    }
    const idx = cfiSpineIndex(selCfi);
    const removed: MarkItem[] = [];
    let kept: MarkItem[] = [];
    for (let j = 0; j < api.state.marks.length; j++) {
        const om = api.state.marks[j];
        let hit = false;
        if (cfiSpineIndex(om.cfi) === idx) {
            try {
                const or = parsed.contents.range(om.cfi);
                if (or && (rangesIntersect(parsed.range, or) || rangesTouch(parsed.range, or))) hit = true;
            } catch (e) {}
            if (!hit && om.cfi === selCfi) hit = true;
        }
        if (hit) removed.push(om); else kept.push(om);
    }
    let changed = true;
    while (changed && kept.length && removed.length) {
        changed = false;
        let union: Range | null = null;
        for (let r2 = 0; r2 < removed.length; r2++) {
            try {
                const rr = parsed.contents.range(removed[r2].cfi);
                if (!rr) continue;
                if (!union) { union = rr; continue; }
                if (union.compareBoundaryPoints(Range.START_TO_START, rr) > 0) union.setStart(rr.startContainer, rr.startOffset);
                if (union.compareBoundaryPoints(Range.END_TO_END, rr) < 0) union.setEnd(rr.endContainer, rr.endOffset);
            } catch (e) {}
        }
        if (!union) break;
        for (let k = kept.length - 1; k >= 0; k--) {
            const km = kept[k];
            if (cfiSpineIndex(km.cfi) !== idx) continue;
            try {
                const kr = parsed.contents.range(km.cfi);
                if (kr && (rangesIntersect(union, kr) || rangesTouch(union, kr))) { removed.push(km); kept.splice(k, 1); changed = true; }
            } catch (e) {}
        }
    }
    api.state.marks = kept;
    return removed.length;
}

export function restoreMarks(api: ReaderApi): void {
    const reg = api.viewRegistry || [];
    for (let i = 0; i < reg.length; i++) restoreMarksForView(api, reg[i].section, reg[i].contents);
}

export function restoreMarksForView(api: ReaderApi, section: any, contents: any): void {
    if (!contents || !contents.document || !section) return;
    const doc = contents.document;
    const old = doc.getElementById("epubHlOverlay");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const svgNS = "http://www.w3.org/2000/svg";
    const svgEl = doc.createElementNS(svgNS, "svg");
    svgEl.setAttribute("id", "epubHlOverlay");
    const w = Math.max(doc.body.scrollWidth || 0, doc.documentElement.scrollWidth || 0);
    const h = Math.max(doc.body.scrollHeight || 0, doc.documentElement.scrollHeight || 0);
    svgEl.setAttribute("width", w);
    svgEl.setAttribute("height", h);
    svgEl.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:5;overflow:visible";
    const list = api.state.marks || [];
    const win = contents.window;
    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (cfiSpineIndex(m.cfi) !== section.index) continue;
        try {
            const range = contents.range(m.cfi);
            if (!range) continue;
            const merged = mergeRects(range); // 合并同行矩形，防半透明叠加变深
            for (let j = 0; j < merged.length; j++) {
                const rr = merged[j];
                const rw = rr.right - rr.left, rh = rr.bottom - rr.top;
                if (rw < 1 || rh < 1) continue;
                const rect = doc.createElementNS(svgNS, "rect");
                rect.setAttribute("x", rr.left + (win.pageXOffset || 0));
                rect.setAttribute("y", rr.top + (win.pageYOffset || 0));
                rect.setAttribute("width", rw);
                rect.setAttribute("height", rh);
                rect.setAttribute("fill", m.color || "#FACA5A");
                rect.setAttribute("data-mark-cfi", m.cfi);
                // 双模式渲染（同 PDF type=text/border）：填充 color-mix 35% 或 2px 边框
                if (m.type === "border") {
                    rect.setAttribute("fill-opacity", "0");
                    rect.setAttribute("stroke", m.color || "#FACA5A");
                    rect.setAttribute("stroke-width", "2");
                } else {
                    rect.setAttribute("fill-opacity", "0.35");
                }
                svgEl.appendChild(rect);
            }
        } catch (e) {}
    }
    doc.body.appendChild(svgEl);
}

/* 点击/右键命中标注：caret 判定 + 几何兜底 */
export function findMarkAt(api: ReaderApi, section: any, contents: any, doc: Document, x: number, y: number): MarkItem | null {
    const list = api.state.marks || [];
    try {
        if (!section || !contents) return null;
        const caret = doc.caretRangeFromPoint(x, y);
        if (caret) {
            for (let i = 0; i < list.length; i++) {
                if (cfiSpineIndex(list[i].cfi) !== section.index) continue;
                let mr: Range | null = null;
                try { mr = contents.range(list[i].cfi); } catch (e) {}
                if (!mr) continue;
                if (mr.isPointInRange(caret.startContainer, caret.startOffset)) return list[i];
            }
        }
    } catch (e) {}
    try {
        for (let j = 0; j < list.length; j++) {
            if (cfiSpineIndex(list[j].cfi) !== section.index) continue;
            let mr2: Range | null = null;
            try { mr2 = contents.range(list[j].cfi); } catch (e2) {}
            if (!mr2) continue;
            const rects = mr2.getClientRects();
            for (let k = 0; k < rects.length; k++) {
                const rc = rects[k];
                if (rc.width < 1 || rc.height < 1) continue;
                if (x >= rc.left - 2 && x <= rc.right + 2 && y >= rc.top - 2 && y <= rc.bottom + 2) return list[j];
            }
        }
    } catch (e3) {}
    return null;
}

export function addMark(api: ReaderApi, cfi: string, color: string, text: string, viewContents?: any): void {
    api.state.marks = api.state.marks || [];
    for (let i = 0; i < api.state.marks.length; i++) {
        if (api.state.marks[i].cfi === cfi) {
            api.state.marks[i].color = color;
            api.state.marks[i].text = text;
            api.state.annoColor = color;
            saveState(api); renderMarkList(api); restoreMarks(api); return;
        }
    }
    // 高亮不可重叠：与旧标注文本范围相交的先移除
    const parsed = viewForCfi(api, cfi, viewContents);
    if (parsed) {
        const kept = [];
        for (let j = 0; j < api.state.marks.length; j++) {
            const om = api.state.marks[j];
            let keep = true;
            if (cfiSpineIndex(om.cfi) === cfiSpineIndex(cfi)) {
                try {
                    const or = parsed.contents.range(om.cfi);
                    if (or && rangesIntersect(parsed.range, or)) keep = false;
                } catch (e) {}
            }
            if (keep) kept.push(om);
        }
        api.state.marks = kept;
    }
    api.state.annoColor = color; // 颜色记忆
    api.state.marks.push({ cfi: cfi, color: color, text: text, type: api.state.annoMode === "border" ? "border" : "text" });
    saveState(api);
    renderMarkList(api);
    restoreMarks(api);
    clearAllSelections(api);
}

export function removeMarks(api: ReaderApi, marks: MarkItem[]): void {
    const set: Record<string, number> = {};
    for (let i = 0; i < marks.length; i++) set[marks[i].cfi] = 1;
    api.state.marks = (api.state.marks || []).filter(function (x) { return !set[x.cfi]; });
    saveState(api); renderMarkList(api); restoreMarks(api);
}

/* 侧栏标注列表 */
export function renderMarkList(api: ReaderApi): void {
    const host = api.root.querySelector(".epub-mini__mark-list");
    if (!host) return;
    const list = api.state.marks || [];
    if (!list.length) { host.innerHTML = '<div class="epub-mini__toc-empty">暂无标注</div>'; return; }
    host.innerHTML = "";
    for (let i = 0; i < list.length; i++) {
        (function (m: MarkItem) {
            const d = document.createElement("div");
            d.className = "epub-mini__mark-item";
            d.title = "点击跳转到标注位置";
            d.innerHTML = '<span class="epub-mini__mark-color" style="background-color:' + escapeHTML(m.color) + '"></span>' +
                '<span class="epub-mini__mark-text">' + escapeHTML(m.text || "（无文本）") + '</span>' +
                '<button class="epub-mini__mark-copy" title="复制标注引用">' + svg("iconCopy") + '</button>' +
                '<button class="epub-mini__mark-del" title="删除">' + svg("iconTrashcan") + '</button>';
            d.querySelector(".epub-mini__mark-copy").addEventListener("click", function (ev) {
                ev.stopPropagation();
                copyText(buildMarkRef(api, m));
                showToast(api, "已复制标注引用，粘贴到文档即可点击跳转");
            });
            d.querySelector(".epub-mini__mark-del").addEventListener("click", function (ev) {
                ev.stopPropagation();
                removeMarks(api, [m]);
                showToast(api, "已删除标注");
            });
            d.addEventListener("click", function () { jumpApi(api, m.cfi); });
            host.appendChild(d);
        })(list[i]);
    }
}

/* 选中弹层（文字上方）：7 色方块 + 显示/隐藏背景 + 复制标注 + 移除高亮 */
export function showUtil(api: ReaderApi, cfi: string, text: string, cancelMark: MarkItem | null, viewContents?: any): void {
    const util = api.root.querySelector(".epub-mini__util");
    if (!util) return;
    api.selCfi = cfi;
    api.selText = text || "";
    api.selMark = cancelMark || null;
    api.selContents = viewContents || null;
    const box = util.querySelector(".epub-mini__colors") as HTMLElement;
    if (!box.dataset.built) {
        let h = "";
        for (let i = 0; i < HL_COLORS.length; i++) h += '<button class="epub-mini__color-square" style="background-color:' + HL_COLORS[i] + '" data-color="' + HL_COLORS[i] + '"></button>';
        box.innerHTML = h;
        box.dataset.built = "1";
        // 点色块 = 立即按该色创建高亮（同 PDF），然后收起弹层
        box.addEventListener("click", function (ev) {
            const b = (ev.target as HTMLElement).closest && (ev.target as HTMLElement).closest("[data-color]");
            if (!b || !api.selCfi) return;
            addMark(api, api.selCfi, b.getAttribute("data-color"), api.selText, api.selContents);
            util.classList.add("fn__none");
        });
    }
    // 记忆色选中描边（记住上次使用的标注色）
    const sqs = box.querySelectorAll(".epub-mini__color-square");
    const memo = api.state.annoColor || HL_COLORS[2]; // 默认黄，与 PDF 观感一致
    for (let k = 0; k < sqs.length; k++) {
        (sqs[k] as HTMLElement).style.outline = sqs[k].getAttribute("data-color") === memo ? "2px solid var(--b3-theme-primary)" : "";
        (sqs[k] as HTMLElement).style.outlineOffset = "1px";
    }
    // 无背景模式常驻开关的高亮态（border=无背景 为当前默认时亮起）
    const tb = util.querySelector('[data-util="toggle"]');
    if (tb) tb.classList.toggle("epub-mini__toggle-on", api.state.annoMode === "border");
    if (cancelMark) util.classList.add("epub-mini__util--cancel");
    else util.classList.remove("epub-mini__util--cancel");
    util.classList.remove("fn__none"); // 先显示再量尺寸定位
    positionUtil(api, util as HTMLElement, viewContents, cfi);
}

/* 弹层定位：悬在选区/标注文字上方；顶部放不下落到下方，横向夹在容器内 */
function positionUtil(api: ReaderApi, util: HTMLElement, viewContents?: any, cfi?: string): void {
    try {
        let selRect: DOMRect | null = null;
        if (viewContents) {
            try {
                const sel = viewContents.window.getSelection();
                if (sel && sel.rangeCount && !sel.isCollapsed) selRect = sel.getRangeAt(0).getBoundingClientRect();
            } catch (e) {}
        }
        if (!selRect && cfi) {
            const parsed = viewForCfi(api, cfi, viewContents);
            if (parsed) selRect = parsed.range.getBoundingClientRect();
        }
        if (!selRect || (!selRect.width && !selRect.height)) { util.style.left = ""; util.style.top = ""; return; }
        const rootRect = api.root.getBoundingClientRect();
        let fx = 0, fy = 0;
        try {
            const frame = viewContents ? viewContents.document.defaultView.frameElement : null;
            if (frame) { const frr = frame.getBoundingClientRect(); fx = frr.left; fy = frr.top; }
        } catch (e) {}
        const uw = util.offsetWidth, uh = util.offsetHeight;
        const vx = selRect.left + fx - rootRect.left;
        const vy = selRect.top + fy - rootRect.top;
        let left = vx + (selRect.width - uw) / 2;
        let top = vy - uh - 8;
        if (top < 4) top = vy + selRect.height + 8;
        const rootW = api.root.clientWidth, rootH = api.root.clientHeight;
        top = Math.max(4, Math.min(top, rootH - uh - 4));
        if (left < 4) left = 4;
        if (left + uw > rootW - 4) left = Math.max(4, rootW - uw - 4);
        util.style.left = Math.round(left) + "px";
        util.style.top = Math.round(top) + "px";
    } catch (e) {}
}

export function closeUtil(api: ReaderApi): void {
    try {
        const u = api.root && api.root.querySelector(".epub-mini__util");
        if (u && !u.classList.contains("fn__none")) u.classList.add("fn__none");
    } catch (e) {}
}

/** 面板当前是否可见（关闭判据用：可见 = 该收，不可见 = 别动） */
export function isUtilVisible(api: ReaderApi): boolean {
    try {
        const u = api.root && api.root.querySelector(".epub-mini__util");
        return !!(u && !u.classList.contains("fn__none"));
    } catch (e) { return false; }
}

/* ---------- 选词面板：松手才弹 + 按实时选区定位 ----------
 *
 * 【问题】面板原挂 selectionchange + 防抖（epub.js 250ms / 手机 350ms），而
 * selectionchange 在拖动过程中就连发 → 拖到一半停顿超时就提前弹出。且 epub.js 的
 * selected 全库只有一个发射点（onSelectionChange 的 250ms 定时器），松手后不再有
 * 第二次 —— 所以「拖动中直接 return」会把唯一那次丢掉，表现为「有时候弹有时候不弹」。
 *
 * 【结论】三条：
 *   ① 判据用 pointerup / pointercancel，不用 selectionchange；setTimeout 只为
 *      让浏览器把选区更新完（30ms），不是防抖。
 *   ② 拖动中不弹但**存票**，指针抬起时兑现；兑现内容按实时选区重算 cfi 与文本
 *      （票上的旧位置作废）。兑现点：iframe 内 markSettled + window 级兜底
 *      settleAllViews（抬起事件派发给指针当时所在文档，iframe 内未必收得到）。
 *   ③ selected 降为辅路径，只覆盖 Ctrl+A 这类没有指针抬起的选中。 */

const SEL_POPUP_DELAY = 30;   // 抬手后留给浏览器收尾选区的时间
const SEL_DEFER_MAX = 1500;   // 兜底：万一所有层级的抬起事件都没收到，到期照弹

/** 读实时选区 → {cfi, text}；没有有效选中返回 null。
 *  fb 仅为 contents.cfiFromRange 失效时的备用先前值。 */
function readSelection(contents: any, fb?: { cfi: string; text: string }): { cfi: string; text: string } | null {
    try {
        const sel = contents.window && contents.window.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
            const text = String(sel.toString() || "");
            if (text.trim()) {
                let cfi = "";
                try { cfi = contents.cfiFromRange(sel.getRangeAt(0)); } catch (e) {}
                if (!cfi && fb) cfi = fb.cfi;
                if (cfi) return { cfi: cfi, text: text };
            }
        }
    } catch (e) {}
    return null;
}

/** 排一次弹出。每调用一次就重置定时器 —— 等价于「最后一次说了算」，
 *  与思源 anno.ts 的 scheduleSelectionToolbar 同一意图。 */
export function scheduleSelectionPanel(
    api: ReaderApi, contents: any, hideWhenEmpty?: boolean,
    fb?: { cfi: string; text: string }, why?: string
): void {
    if (!contents) return;
    try { clearTimeout(contents.__selPopTimer); } catch (e) {}
    contents.__selPopTimer = setTimeout(function () {
        contents.__selPopTimer = null;
        const got = readSelection(contents, fb);
        if (!got) {
            if (hideWhenEmpty) closeUtil(api);
            return;
        }
        // 同一选区重复弹没意义：pointerup 与 selected 两条路可能都走到这里
        if (contents.__selPopCfi === got.cfi && isUtilVisible(api)) return;
        contents.__selPopCfi = got.cfi;
        /* 紧跟的那次 click 是同一个手势的尾巴，而 click 分支的规矩是「面板可见就收」——
         * 不打这个标记，刚弹出的面板会被它自己那下 click 立刻关掉，等于没弹。 */
        contents.__selTailClick = true;
        console.log("[UTIL] 弹出面板" + (why ? " " + why : "") + " 字数=" + got.text.length);
        try { showUtil(api, got.cfi, got.text, null, contents); } catch (e) {}
    }, SEL_POPUP_DELAY);
}

export function isSelectionSettled(contents: any): boolean {
    // contents 未知时按「已松手」处理，保证不因标记缺失而吞掉正常弹层
    return !contents || contents.__selSettled !== false;
}

/** 存票：selected 到了但指针还按着 —— 记下来，松手时补弹。**绝不能丢**。 */
export function deferSelection(api: ReaderApi, contents: any, cfi: string, text: string, why: string): void {
    if (!contents) return;
    contents.__selPending = { api: api, cfi: cfi, text: text, at: Date.now() };
    console.log("[UTIL] 拖动中，存票待补弹（" + why + "）");
    try {
        clearTimeout(contents.__selDeferTimer);
        /* 兜底定时器要能区分两件事：「用户还按着，只是在犹豫」和「抬起事件真的丢了」。
         * 前者**绝不能弹**（那就是最初报的 bug），所以按着就再等一轮。
         * __pointerDown 由 window 级与 iframe 级两套按下/抬起监听共同维护。 */
        const retryDefer = function () {
            if (!contents.__selPending) return;
            /* 还按着 = 用户在犹豫，**绝不能弹**（那就是最初报的 bug），再等一轮。
             * 但有界：某些 Android WebView 长按被系统接管时可能既没有 pointerup
             * 也没有 blur，标志会永远除不掉 —— 等 3 轮（约 4.5s）后照弹。
             * 宁可在「按住不放几十秒」这种极端情况下弹早，也不能让它就此消失。 */
            const tries = (contents.__selDeferTries || 0) + 1;
            if (tries <= 3 && api && (api as any).__pointerDown) {
                contents.__selDeferTries = tries;
                contents.__selDeferTimer = setTimeout(retryDefer, SEL_DEFER_MAX);
                return;
            }
            contents.__selDeferTries = 0;
            console.log("[UTIL] 兜底补弹（疑似未收到抬起事件）");
            settleView(contents, "超时兜底");
        };
        contents.__selDeferTries = 0;
        contents.__selDeferTimer = setTimeout(retryDefer, SEL_DEFER_MAX);
    } catch (e) {}
}

/** 兑票：把 selected 报来的那次选中补弹出来。
 *  内容仍经 scheduleSelectionPanel 按**此刻的实时选区**重算 —— 用户可能在
 *  「停顿」之后又拖长了一段，票上的 cfi 已经不是最终范围了。 */
function flushPending(contents: any, why: string): void {
    const tk = contents.__selPending;
    contents.__selPending = null;
    try { clearTimeout(contents.__selDeferTimer); } catch (e) {}
    contents.__selDeferTimer = null;
    if (!tk || !tk.api) return;
    if (!readSelection(contents, tk)) {
        console.log("[UTIL] 松手 " + why + "，但选区已撤销 → 票作废");
        return;
    }
    scheduleSelectionPanel(tk.api, contents, false, tk, "补弹-" + why);
}

/** 标记「已松手」；手上有票则一并兑现。 */
export function settleView(contents: any, why?: string): void {
    if (!contents) return;
    contents.__selSettled = true;
    if (contents.__selPending) flushPending(contents, why || "松手");
}

/** window 级兜底：把本阅读器所有已注册 view 置位并兑票。
 *  用于指针「在这里按下、在那里松开」—— 抬起事件派发给指针当时所在的文档，
 *  iframe 内的监听收不到；拖出浏览器窗口、被系统手势接管（touchcancel）同理。
 *  由 tab.ts 在 window 捕获阶段调用。 */
export function settleAllViews(api: ReaderApi, why?: string): void {
    try {
        (api as any).__pointerDown = false;
        const reg = (api && api.viewRegistry) || [];
        for (let i = 0; i < reg.length; i++) {
            const c = reg[i] && reg[i].contents;
            if (c) settleView(c, (why || "兜底") + "-window");
        }
    } catch (e) {}
}

/* 章节文档内点击/右键：点标注→取消菜单；面板可见→点击即收；右键标注→复制引用；点正文→收侧栏 */
export function bindMarkClick(api: ReaderApi, section: any, contents: any): void {
    if (!contents || !contents.document) return;
    const doc = contents.document;
    if (doc.__epubMiniMarkBound) return;
    doc.__epubMiniMarkBound = true;
    /* 指针抬起跟踪：桌面 mouse + 触摸 touch 两套都要跟，缺一套会出现「鼠标正常、手指
     * 不正常」的分裂行为。★touchcancel 必须一起听：系统接管长按时收到的是它而不是
     * touchend，漏掉会让标记永久卡 false → 面板再也不弹。 */
    contents.__selSettled = true;
    const markSettled = function (why: string) {
        (api as any).__pointerDown = false;
        settleView(contents, why);   // 置位，并把可能存在的票兑掉
    };
    doc.addEventListener("mousedown", function () {
        contents.__selSettled = false;
        (api as any).__pointerDown = true;   // 兜底定时器靠它分辨「还在犹豫」与「事件丢了」
        /* 「本次手势的尾巴 click」标记绝不能跨手势残留，否则下一次点击
         * 会被当成尾巴放过，面板该收时不收。按下就是新手势的起点。 */
        contents.__selTailClick = false;
        console.log("[UTIL] 按下 mousedown");
    }, true);
    doc.addEventListener("touchstart", function () {
        contents.__selSettled = false;
        (api as any).__pointerDown = true;
        contents.__selTailClick = false;
        console.log("[UTIL] 按下 touchstart");
    }, true);
    doc.addEventListener("mouseup", function () { markSettled("mouseup"); }, true);
    doc.addEventListener("touchend", function () { markSettled("touchend"); }, true);
    doc.addEventListener("touchcancel", function () { markSettled("touchcancel"); }, true);
    /* **主路径**：指针抬起 = 选完了（思源 asset/anno.ts 的 pointerup/pointercancel 同一份处理）。
     * pointer 事件鼠标 / 触屏 / 手写笔通吃，一套顶三套；
     * pointercancel 对应「系统把手势抢走了」这类收不到 pointerup 的情况。 */
    const onPointerUp = function (ev: any) {
        (api as any).__pointerDown = false;
        settleView(contents, ev && ev.type);
        scheduleSelectionPanel(api, contents, false, undefined, "pointerup");
    };
    doc.addEventListener("pointerup", onPointerUp, true);
    doc.addEventListener("pointercancel", onPointerUp, true);
    doc.addEventListener("click", function (ev: MouseEvent) {
        // 点击阅读区收侧栏（iframe 内点击不冒泡到主文档，需在此处理）
        try { api.root.classList.remove("epub-mini--sidebar-open"); } catch (e) {}
        /* 本次 click 是拖选手势自带的尾巴（松手紧跟的那一下），面板就是它刚唤出来的
         * —— 这里一收，等于刚弹就被自己关掉。跳过即可。 */
        if (contents.__selTailClick) {
            contents.__selTailClick = false;
            return;
        }
        /* 面板可见 = 该收手，点哪都收（点选中的文字、非选中的文字都收）。
         * 旧判据是「选区是否塌陷」，两个场景都不成立：点选中的文字选区不塌陷；
         * 点非选中的文字时 click 早于浏览器更新选区，同样不塌陷 → 面板赖着不走。
         * 换成「可见就关」之所以安全，是因为弹层已改为松手后才出现
         * （见 isSelectionSettled）——拖选时面板还没弹，这个分支不会误伤。 */
        if (isUtilVisible(api)) {
            closeUtil(api);
            return;   // 收了就走，别让这次点击再去命中标注弹取消菜单
        }
        const mark = findMarkAt(api, section, contents, doc, ev.clientX, ev.clientY);
        if (!mark) return;
        /* 手机端：点击已标注内容 = 直接复制标注引用（260ms 延迟执行，双击删除会在
         * dblclick 里取消这个定时器，避免删之前先弹两次「已复制」）；
         * 桌面端保持原样：弹出取消/复制/换色菜单 */
        if ((api as any).__isMobile) {
            clearTimeout((doc as any).__ymerMarkTap);
            const m = mark;
            (doc as any).__ymerMarkTap = setTimeout(function () {
                copyText(buildMarkRef(api, m));
                showToast(api, "已复制标注引用，粘贴到文档即可点击跳转");
            }, 260);
            return;
        }
        showUtil(api, mark.cfi, mark.text, mark, contents);
    }, false);
    /* 选区高亮自绘：原生 ::selection 画在文字层，永远低于 z-index:5 的标注 SVG 覆盖层，
     * 无法直接抬高 → 把 ::selection 背景置透明，在 z-index:6（标注层之上）自画选区矩形，
     * 实现「标注恒在、蓝色选区叠加其上」的真实层级。 */
    try {
        if (!doc.getElementById("epubSelKillStyle")) {
            const st = doc.createElement("style");
            st.id = "epubSelKillStyle";
            st.textContent = "::selection{background:transparent}";
            doc.head.appendChild(st);
        }
    } catch (e) {}
    const selOverlay = function (): any {
        let o: any = doc.getElementById("epubSelOverlay");
        if (!o) {
            const svgNS = "http://www.w3.org/2000/svg";
            o = doc.createElementNS(svgNS, "svg");
            o.setAttribute("id", "epubSelOverlay");
            o.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:6;overflow:visible";
            doc.body.appendChild(o);
        }
        return o;
    };
    doc.addEventListener("selectionchange", function () {
        const o = selOverlay();
        const svgNS = "http://www.w3.org/2000/svg";
        while (o.firstChild) o.removeChild(o.firstChild);
        let sel: Selection | null = null;
        try { sel = contents.window.getSelection(); } catch (e) { return; }
        if (!sel || !sel.rangeCount || sel.isCollapsed) return;
        try {
            const range = sel.getRangeAt(0);
            const win = contents.window;
            o.setAttribute("width", Math.max(doc.body.scrollWidth || 0, doc.documentElement.scrollWidth || 0));
            o.setAttribute("height", Math.max(doc.body.scrollHeight || 0, doc.documentElement.scrollHeight || 0));
            const lines = mergeRects(range); // 复用标注同款：逐文本节点取矩形 + 同行归并
            for (let i = 0; i < lines.length; i++) {
                const rr = lines[i];
                const rect = doc.createElementNS(svgNS, "rect");
                rect.setAttribute("x", rr.left + (win.pageXOffset || 0));
                rect.setAttribute("y", rr.top + (win.pageYOffset || 0));
                rect.setAttribute("width", rr.right - rr.left);
                rect.setAttribute("height", rr.bottom - rr.top);
                rect.setAttribute("fill", "#3390FF");
                rect.setAttribute("fill-opacity", "0.35");
                o.appendChild(rect);
            }
        } catch (e) {}
    });
    /* Tab 快捷键：章节文档内开/关目录侧栏（iframe 内 keydown 不冒泡到宿主面板，须在此接） */
    doc.addEventListener("keydown", function (ev: KeyboardEvent) {
        if (ev.key !== "Tab") return;
        ev.preventDefault();
        try { if (api.__toggleSidebar) api.__toggleSidebar(); } catch (e) {}
    });
    /* 双击已标注文字 = 取消该标注（双击未标注文字仍为原生选词） */
    doc.addEventListener("dblclick", function (ev: MouseEvent) {
        clearTimeout((doc as any).__ymerMarkTap); // 取消挂起的「单击复制」，别删之前先弹复制
        const mark = findMarkAt(api, section, contents, doc, ev.clientX, ev.clientY);
        if (!mark) return;
        removeMarks(api, [mark]);
        try { contents.window.getSelection().removeAllRanges(); } catch (e) {}
        closeUtil(api);
        showToast(api, "已取消标注");
    });
    /* ---------- 手机端（__isMobile 由 mobile.ts 开层时置位）----------
     * 长按文字 → 原生选择光标 + 我们自己的标注面板（350ms 防抖后弹出）；
     * 点选中的文字 = 按记忆色确认标注；点面板色块 = 按所选色确认标注。
     * 另：横滑手势经 api.__mobileSwipe 转发给手机层（iframe 内 touch 不冒泡出宿主）。 */
    if ((api as any).__isMobile) {
        // iOS：禁长按 callout（放大镜+系统菜单）；Android 原生菜单由 contextmenu preventDefault 压制
        try {
            if (!doc.getElementById("epubTouchCallout")) {
                const st = doc.createElement("style");
                st.id = "epubTouchCallout";
                st.textContent = "body{-webkit-touch-callout:none}";
                doc.head.appendChild(st);
            }
        } catch (e) {}
        let mSel: { cfi: string; text: string; rects: DOMRect[] } | null = null;
        let mTimer: any = null;
        doc.addEventListener("selectionchange", function () {
            clearTimeout(mTimer);
            mTimer = setTimeout(function () {
                mSel = null;
                let sel: Selection | null = null;
                try { sel = contents.window.getSelection(); } catch (e) { return; }
                if (!sel || !sel.rangeCount || sel.isCollapsed) return;
                const text = sel.toString();
                if (!text || !text.trim()) return;
                let range: Range;
                try { range = sel.getRangeAt(0); } catch (e2) { return; }
                let cfi: string | null = null;
                try { cfi = section.cfiFromRange(range); } catch (e3) {}
                if (!cfi) return;
                mSel = { cfi: cfi, text: text, rects: Array.prototype.slice.call(range.getClientRects()) };
                // 手指仍在拖动中：存票，等 pointerup/touchend 补弹。此处**绝不能
                // 直接 return** —— selectionchange 只问「选区多久没变」，这条
                // 分支之后不会再有第二次，丢了票就等于面板永不弹。
                if (!isSelectionSettled(contents)) {
                    mSel = null;
                    deferSelection(api, contents, cfi, text, "手指拖动中");
                    return;
                }
                try { showUtil(api, cfi, text, null, contents); } catch (e4) {}
            }, 350);
        });
        // 点选中的文字 = 确认标注（tap 会先塌陷选区，故用塌陷前缓存的矩形判定）
        doc.addEventListener("click", function (ev: MouseEvent) {
            if (!mSel) return;
            let hit = false;
            for (let i = 0; i < mSel.rects.length; i++) {
                const r = mSel.rects[i];
                if (ev.clientX >= r.left - 4 && ev.clientX <= r.right + 4 &&
                    ev.clientY >= r.top - 6 && ev.clientY <= r.bottom + 6) { hit = true; break; }
            }
            if (!hit) return;
            ev.stopPropagation(); // 别让冒泡 click 把新标注当「点标注」又弹取消菜单
            addMark(api, mSel.cfi, api.state.annoColor || HL_COLORS[2], mSel.text, contents);
            closeUtil(api);
            try { contents.window.getSelection().removeAllRanges(); } catch (e) {}
            showToast(api, "已标注");
            mSel = null;
        }, true); // 捕获阶段，先于冒泡 click（避免命中标注时又弹取消菜单）
        // 横滑手势转发：右滑循环目录/标注，左滑收侧栏（判定 = gesture.ts 三道防御，
        // 主轴锁定防弧线误触发；阈值与宿主层同源）
        bindHorizontalSwipe(doc, function (dir: "left" | "right") {
            try { if ((api as any).__mobileSwipe) (api as any).__mobileSwipe(dir); } catch (e) {}
        });
    }
    doc.addEventListener("contextmenu", function (ev: MouseEvent) {
        ev.preventDefault();
        ev.stopPropagation();
        /* 手机端：长按也触发 contextmenu —— 只压掉原生菜单，标注走选区防抖弹面板
         * （桌面端右键=立即按记忆色标注/复制引用的逻辑不适用于触屏） */
        if ((api as any).__isMobile) return;
        // 有选区 → 右键快捷标注：无高亮直接高亮、含已标注则重新标注（addMark 自带相交删除）
        let sel: Selection | null = null, text = "";
        try { sel = contents.window.getSelection(); } catch (e) {}
        let hasSel = false;
        try { hasSel = !!(sel && sel.rangeCount && !sel.isCollapsed && (text = sel.toString()) && text.trim()); } catch (e) {}
        if (hasSel) {
            let cfi: string | null = null;
            try { cfi = section.cfiFromRange(sel.getRangeAt(0)); } catch (e) {}
            if (cfi) {
                addMark(api, cfi, api.state.annoColor || HL_COLORS[2], text, contents);
                try { sel.removeAllRanges(); } catch (e2) {}
                closeUtil(api);
                showToast(api, "已按记忆色标注（可左键点色块换色）");
            }
            return;
        }
        // 无选区 → 右键已有标注 = 直接复制引用
        const mark = findMarkAt(api, section, contents, doc, ev.clientX, ev.clientY);
        if (!mark) return;
        copyText(buildMarkRef(api, mark));
        showToast(api, "已复制标注引用，粘贴到文档即可点击跳转");
    }, false);
}

/* registerView/findView/clearAllSelections/viewForCfi 在 ./views（re-export 方便外部单点导入） */
export { cfiSpineIndex, registerView, findView, clearAllSelections, viewForCfi } from "./views";
