/* 选区矩形几何：相交判定 + 矩形合并 */

export function rangesIntersect(a: Range, b: Range): boolean {
    try {
        if (a.compareBoundaryPoints(Range.START_TO_END, b) === -1) return false;
        if (a.compareBoundaryPoints(Range.END_TO_START, b) === 1) return false;
        return true;
    } catch (e) { return false; }
}

export function rangesTouch(a: Range, b: Range): boolean {
    try {
        if (a.compareBoundaryPoints(Range.START_TO_END, b) === 0) return true;
        if (a.compareBoundaryPoints(Range.END_TO_START, b) === 0) return true;
        return false;
    } catch (e) { return false; }
}

/* 矩形合并 v3：改从「文本节点」取矩形，根治整行误刷。
 * 之前用 range.getClientRects() 会混入块级元素框（宽度=整行）——行内只选中
 * 几个字时，该行的块框就是唯一矩形，丢大框算法保不住它 → 整行被刷。
 * 现在遍历选区内文本节点、逐个对选中片段建 Range 取矩形：天生只有文字框，
 * 块框永远混不进来；再按 top 相近(≤6px)归并同行，消嵌套行内的碎片矩形。 */
export function mergeRects(range: Range) {
    const doc = (range.startContainer as Node).ownerDocument || document;
    const rects: { left: number; top: number; right: number; bottom: number }[] = [];
    const pushRange = function (r: Range) {
        const list = r.getClientRects();
        for (let i = 0; i < list.length; i++) {
            const it = list[i];
            if (it.width > 0.5 && it.height > 0.5) {
                rects.push({ left: it.left, top: it.top, right: it.right, bottom: it.bottom });
            }
        }
    };
    try {
        const anc = range.commonAncestorContainer;
        if (anc.nodeType === 3) {
            // 选区在单个文本节点内
            const r0 = doc.createRange();
            r0.setStart(range.startContainer, range.startOffset);
            r0.setEnd(range.endContainer, range.endOffset);
            pushRange(r0);
        } else {
            const walker = doc.createTreeWalker(anc, NodeFilter.SHOW_TEXT, null);
            let node;
            while ((node = walker.nextNode())) {
                if (!node.nodeValue.length) continue;
                // 用 comparePoint 判定节点与选区的相对位置（文档序遍历，可提前终止）
                let pos = 1;
                try { pos = range.comparePoint(node, 0); } catch (e) { continue; }
                if (pos === 1) break;                       // 已到选区末尾之后
                if (pos === -1) continue;                   // 还在选区开始之前
                const s = (range.startContainer === node) ? range.startOffset : 0;
                const e = (range.endContainer === node) ? range.endOffset : node.nodeValue.length;
                if (e <= s) continue;
                const r1 = doc.createRange();
                r1.setStart(node, s);
                r1.setEnd(node, e);
                pushRange(r1);
            }
        }
    } catch (e2) {
        // 兜底：老办法（可能混入块框，但不至于画不出）
        pushRange(range);
    }
    // 同行归并：top 相近(≤6px)的碎片矩形拼成整行条（left/right 取极值）
    rects.sort(function (a, b) { return a.top - b.top || a.left - b.left; });
    const lines: typeof rects = [];
    for (let j = 0; j < rects.length; j++) {
        const r = rects[j];
        const last = lines.length ? lines[lines.length - 1] : null;
        if (last && Math.abs(last.top - r.top) <= 6) {
            last.left = Math.min(last.left, r.left);
            last.right = Math.max(last.right, r.right);
            last.top = Math.min(last.top, r.top);
            last.bottom = Math.max(last.bottom, r.bottom);
        } else {
            lines.push(r);
        }
    }
    return lines;
}
