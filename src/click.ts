/* 点击拦截（捕获阶段，三连；Shift/Ctrl/Cmd 交回思源原生） */
import { parseMarkRef, jumpToCfi } from "./markref";
import { openEpub } from "./open";

export function onClickCapture(ev: MouseEvent): void {
    try {
        if (ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
        const el = (ev.target as HTMLElement).closest && (ev.target as HTMLElement).closest('[data-href], a[href]');
        if (!el) return;
        const href = el.getAttribute("data-href") || el.getAttribute("href") || "";
        // 点击思源文档里的标注标记 → 打开 EPUB 并定位
        const ref = parseMarkRef(href);
        if (ref) {
            ev.preventDefault();
            ev.stopPropagation();
            if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
            let noSplitRef = false;
            try { noSplitRef = !!window.siyuan.config.fileTree.noSplitScreenWhenOpenTab; } catch (e) {}
            // 打开是异步的（先取标注状态再建页签）→ 无论"已开切页签"还是"新开"，
            // 统一走 onReady 回调拿页签定位；jumpToCfi 自带 12s 轮询等 rend，早叫也无妨
            openEpub(ref.path, ev.altKey ? false : !noSplitRef, function (tab: any) {
                jumpToCfi(tab, ref.cfi);
            });
            return;
        }
        if (!/\.epub(\?|#|$)/i.test(href)) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        // Alt：不分屏；否则跟随思源设置「打开文件时不分屏」
        let noSplit = false;
        try { noSplit = !!window.siyuan.config.fileTree.noSplitScreenWhenOpenTab; } catch (e) {}
        openEpub(href, ev.altKey ? false : !noSplit);
    } catch (e) { console.warn("[EPUB-MINI]", "拦截处理异常", e); }
}

/* 手机端 touchend 拦截：点按 epub/标注引用时必须拦在浏览器合成 click 之前——
 * 否则点按的焦点会先落进思源可编辑文档（光标 + 软键盘弹出），click 里的
 * preventDefault 已经晚了。preventDefault(touchend) 阻止合成 click 序列。 */
export function onTouchEndCapture(ev: TouchEvent): void {
    try {
        const el = (ev.target as HTMLElement).closest && (ev.target as HTMLElement).closest('[data-href], a[href]');
        if (!el) return;
        const href = el.getAttribute("data-href") || el.getAttribute("href") || "";
        const ref = parseMarkRef(href);
        if (!ref && !/\.epub(\?|#|$)/i.test(href)) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        // 定位回调两端共用：手机句柄带 __api，jumpToCfi 的轮询（rend + __booted）
        // 在全屏层同样成立；新开时句柄经 onReady 异步送达，已开时同步触发
        const ref2 = ref;
        openEpub(ref2 ? ref2.path : href, false, ref2 ? function (handle: any) {
            jumpToCfi(handle, ref2.cfi);
        } : undefined);
    } catch (e) { console.warn("[EPUB-MINI]", "touchend 拦截处理异常", e); }
}

export function attachInterceptor(): void {
    window.addEventListener("click", onClickCapture, true);
    window.addEventListener("touchend", onTouchEndCapture, true);
}

export function detachInterceptor(): void {
    window.removeEventListener("click", onClickCapture, true);
    window.removeEventListener("touchend", onTouchEndCapture, true);
}
