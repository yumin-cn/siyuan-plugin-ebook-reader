/* 入口分流：手机端（mobile / browser-mobile）没有页签系统 → 全屏覆盖层；
 * 桌面端走原 Tab 路径。渲染核心 wireReader 两端共用。 */
import { getFrontend } from "siyuan";
import { openEpubDesktop } from "./tab";
import { openEpubMobile } from "./mobile";

export function isMobileFrontend(): boolean {
    try { return getFrontend().endsWith("mobile"); } catch (e) { return false; }
}

/* onReady：阅读器句柄就绪时回调（已开=现成页签；新开=页签/全屏层建好后）。
 * openEpub 本身因异步取标注状态不再同步返回句柄 → 需要定位等后续操作走此回调。 */
export function openEpub(path: string, split: boolean, onReady?: (tab: any) => void) {
    if (isMobileFrontend()) return openEpubMobile(path, onReady);
    return openEpubDesktop(path, split, onReady);
}
