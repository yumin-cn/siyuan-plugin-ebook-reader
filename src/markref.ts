/* 标注引用文本形态：epubreader://<编码路径>#<编码CFI>，粘贴进思源文档即成可点击标记。
 * 本文件只负责引用文本的生成与解析；跳转实现全在 jump.ts（唯一通道），
 * jumpToCfi 从那里 re-export 以保持调用方导入面不变。 */
import { displayName } from "./util";
import type { ReaderApi, MarkItem } from "./types";

export { jumpToCfi } from "./jump";

export function parseMarkRef(url: string): { path: string; cfi: string } | null {
    const s = String(url || "");
    if (s.indexOf("epubreader://") !== 0) return null;
    const rest = s.slice("epubreader://".length);
    const hash = rest.indexOf("#");
    if (hash === -1) return null;
    try {
        return { path: decodeURIComponent(rest.slice(0, hash)), cfi: decodeURIComponent(rest.slice(hash + 1)) };
    } catch (e) { return null; }
}

/* 摘录保留原始分行（软换行）：纯文本走思源 Md2BlockDOM，单个 \n = 同块软换行。
 * 每行各包一个 Markdown 链接（同一 cfi，点任意行都能跳）。 */
function markLines(m: MarkItem): string[] {
    const t = String(m.text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    return t.split("\n");
}

export function buildMarkRef(api: ReaderApi, m: MarkItem): string {
    const url = "epubreader://" + encodeURIComponent(api.path) + "#" + encodeURIComponent(m.cfi);
    const lines = markLines(m);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue; /* 空行不能包链接：[](url) 在思源里会变成怪异原始字符 */
        out.push("[" + lines[i] + "](" + url + ")");
    }
    if (!out.length) out.push("[" + displayName(api.path) + "](" + url + ")");
    return out.join("\n");
}
