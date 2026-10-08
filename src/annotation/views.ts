/* 视图注册表：continuous 模式同时存在多个已渲染视图，
 * 标注的解析/绘制/点击必须按各自视图处理 */
import type { ReaderApi } from "../types";

export function cfiSpineIndex(cfi: string): number | null {
    const m = /^epubcfi\(\/6\/(\d+)!/.exec(String(cfi || ""));
    return m ? (parseInt(m[1], 10) / 2 - 1) : null;
}

export function registerView(api: ReaderApi, section: any, contents: any): void {
    try {
        if (!section || !contents || !contents.document) return;
        api.viewRegistry = api.viewRegistry || [];
        let found = null;
        for (let i = 0; i < api.viewRegistry.length; i++) {
            if (api.viewRegistry[i].idx === section.index) found = api.viewRegistry[i];
        }
        if (found) { found.contents = contents; found.section = section; }
        else api.viewRegistry.push({ idx: section.index, contents: contents, section: section });
        api.viewRegistry = api.viewRegistry.filter(function (v) {
            try { return v.contents.document && v.contents.document.body && v.contents.document.body.isConnected; } catch (e) { return false; }
        });
    } catch (e) {}
}

export function findView(api: ReaderApi, spineIdx: number | null) {
    const reg = api.viewRegistry || [];
    for (let i = 0; i < reg.length; i++) {
        if (reg[i].idx !== spineIdx) continue;
        try {
            const c = reg[i].contents;
            if (c && c.document && c.document.body && c.document.body.isConnected) return reg[i];
        } catch (e) {}
    }
    return null;
}

/* 清除所有已注册视图的选区（残留选区会在跨章重渲染时铺满整章） */
export function clearAllSelections(api: ReaderApi): void {
    const reg = (api.viewRegistry || []).slice();
    for (let i = 0; i < reg.length; i++) {
        try { if (reg[i].contents && reg[i].contents.window) reg[i].contents.window.getSelection().removeAllRanges(); } catch (e) {}
    }
}

/* 为 CFI 选一个可用视图解析 Range：优先选中发生时的视图，其次注册表 */
export function viewForCfi(api: ReaderApi, cfi: string, preferContents?: any) {
    const cands: any[] = [];
    if (preferContents && preferContents.document && preferContents.document.body && preferContents.document.body.isConnected) cands.push(preferContents);
    const v = findView(api, cfiSpineIndex(cfi));
    if (v && v.contents) cands.push(v.contents);
    for (let i = 0; i < cands.length; i++) {
        try { const r = cands[i].range(cfi); if (r) return { contents: cands[i], range: r }; } catch (e) {}
    }
    return null;
}
