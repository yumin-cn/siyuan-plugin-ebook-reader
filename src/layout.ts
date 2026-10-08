/* 原生 Wnd / Tab 导航 + 页签条状态修复 */
export function isWnd(x: any): boolean { return !!x && !!x.headersElement && Array.isArray(x.children); }
export function isLayout(x: any): boolean { return !!x && typeof x.direction === "string" && Array.isArray(x.children); }

export function findAllWnds(node: any, out?: any[]): any[] {
    out = out || [];
    if (!node) return out;
    if (isWnd(node)) { out.push(node); return out; }
    if (isLayout(node)) { for (let i = 0; i < node.children.length; i++) findAllWnds(node.children[i], out); }
    return out;
}

export function getActiveWnd(): any {
    const wnds = findAllWnds(window.siyuan && window.siyuan.layout && window.siyuan.layout.centerLayout);
    for (let i = 0; i < wnds.length; i++) {
        if (wnds[i].element && wnds[i].element.classList.contains("layout__wnd--active")) return wnds[i];
    }
    return wnds[0] || null;
}

export function getTabClass(): any {
    const wnds = findAllWnds(window.siyuan && window.siyuan.layout && window.siyuan.layout.centerLayout);
    for (let i = 0; i < wnds.length; i++) {
        const ch = wnds[i].children || [];
        for (let j = 0; j < ch.length; j++) {
            if (ch[j] && ch[j].constructor) return ch[j].constructor;
        }
    }
    return null;
}

export function findEpubTab(path: string): any {
    const wnds = findAllWnds(window.siyuan && window.siyuan.layout && window.siyuan.layout.centerLayout);
    for (let i = 0; i < wnds.length; i++) {
        const ch = wnds[i].children || [];
        for (let j = 0; j < ch.length; j++) {
            const t = ch[j], pe = t && t.panelElement;
            const host = pe && pe.querySelector && pe.querySelector("[data-epub-path]");
            if (host && host.getAttribute("data-epub-path") === path) return t;
        }
    }
    return null;
}

/* 补齐页签条样式：除透明类外还要补 paddingLeft / readonly 条 marginRight / visibility /
 * 拖拽手柄尺寸与 app-region，否则第二个 EPUB 页签撑宽页签条后会垫进右上角工具栏
 * 图标底下（原生页签走 setTabPosition 故正常）。 */
export function refreshWndHeaderState(): void {
    try {
        const cfg = window.siyuan && window.siyuan.config;
        const hideToolbar = cfg && cfg.appearance && cfg.appearance.hideToolbar;
        const isWindowMode = !document.getElementById("toolbar"); // 同 util/functions.ts isWindow()
        if (!hideToolbar && !isWindowMode) return;
        const root = isWindowMode ? window.siyuan.layout.layout : window.siyuan.layout.centerLayout;
        if (!root || !root.element) return;
        const centerRect = root.element.getBoundingClientRect();
        const drag = document.getElementById("drag");
        const dragRect = drag ? drag.getBoundingClientRect() : { left: 0, right: 0 } as any;
        if (drag) {
            drag.style.setProperty("--b3-toolbar-drag-left", "8px");
            drag.style.setProperty("--b3-toolbar-drag-right", "8px");
        }
        const wnds = findAllWnds(root);
        for (let i = 0; i < wnds.length; i++) {
            const w = wnds[i];
            const header = w.headersElement && w.headersElement.parentElement;
            if (!header) continue;
            if (header.classList.contains("fn__none")) header.classList.remove("fn__none");
            const hr = header.getBoundingClientRect(); // 原生先量后清
            header.style.paddingLeft = "";
            if (header.lastElementChild) (header.lastElementChild as HTMLElement).style.marginRight = "";
            header.style.visibility = "";
            const dragEl = header.querySelector(".item--readonly .fn__flex-1") as HTMLElement | null;
            if (hr.top <= 0) {
                if (isWindowMode) {
                    if (hr.left === 0) {
                        const v = parseInt(getComputedStyle(document.body).getPropertyValue("--b3-toolbar-left-mac")) - 5;
                        if (!isNaN(v)) header.style.paddingLeft = v + "px";
                    }
                } else if (drag) {
                    if (hr.left > dragRect.left && hr.left === centerRect.left) {
                        drag.style.setProperty("--b3-toolbar-drag-left", (hr.left - dragRect.left) + "px");
                    } else if (hr.left < dragRect.left) {
                        header.style.paddingLeft = (dragRect.left - hr.left) + "px";
                    }
                }
                if (isWindowMode) {
                    if (hr.right === centerRect.right && header.lastElementChild) {
                        const tw = document.querySelector(".toolbar__window");
                        (header.lastElementChild as HTMLElement).style.marginRight = ((tw ? (tw as HTMLElement).clientWidth : 0) - 4) + "px";
                    }
                } else if (drag) {
                    if (hr.right < dragRect.right && hr.right === centerRect.right) {
                        drag.style.setProperty("--b3-toolbar-drag-right", (dragRect.right - hr.right) + "px");
                    } else if (hr.right > dragRect.right) {
                        // 页签条右缘伸进工具栏拖拽区 → 收 margin 拉回；太窄则整条隐藏（同原生）
                        if (hr.right - dragRect.right + 64 > hr.width) {
                            header.style.visibility = "hidden";
                        } else if (header.lastElementChild) {
                            (header.lastElementChild as HTMLElement).style.marginRight = (hr.right - dragRect.right) + "px";
                        }
                    }
                }
                w.element.classList.remove("layout__wnd--right", "layout__wnd--left", "layout__wnd--center");
                const container = w.element.querySelector(".layout-tab-container");
                if (container) (container as HTMLElement).style.backgroundColor = "";
                w.element.classList.add("layout__wnd--center");
                if (!isWindowMode) {
                    if (hr.left - 1 <= centerRect.left) w.element.classList.add("layout__wnd--left");
                    if (hr.right + 1 >= centerRect.right) w.element.classList.add("layout__wnd--right");
                }
                if (dragEl && dragEl.parentElement && dragEl.parentElement.parentElement) {
                    dragEl.parentElement.parentElement.style.minWidth = "56px";
                    dragEl.style.height = dragEl.parentElement.clientHeight + "px";
                    try { (dragEl.style as any).webkitAppRegion = "drag"; } catch (e2) {}
                }
            } else {
                if (dragEl && dragEl.parentElement && dragEl.parentElement.parentElement) {
                    dragEl.parentElement.parentElement.style.minWidth = "";
                    dragEl.style.height = "";
                    try { (dragEl.style as any).webkitAppRegion = ""; } catch (e2) {}
                }
            }
        }
    } catch (e) { console.warn("[EPUB-MINI]", "刷新页签条状态失败", e); }
}
