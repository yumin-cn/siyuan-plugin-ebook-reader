/* 共享类型。阅读器的 api 对象是随页签生命周期逐步挂字段的「袋子」，
 * 这里集中声明，避免散落 any。 */
export interface MarkItem {
    cfi: string;
    color: string;
    text?: string;
    type?: "text" | "border";
}

export interface ReaderState {
    marks?: MarkItem[];
    annoColor?: string;
    annoMode?: "text" | "border";
    fontSize?: number;
    /* 页码定位点缓存：{ fp: 书籍指纹(章节数:首章href), locs: locations.save() 的返回值 }。
     * 存工作空间而非 localStorage —— 后者按 origin 隔离，而思源桌面端每次启动端口都不同，
     * 重启即失效、页码要重算。随思源同步，跨设备开同一本书也能秒出页码。
     * 体积：约 135KB/50MB 的大书，可接受。 */
    locations?: { fp: string; locs: any };
    /* 阅读进度：{ fp:书籍指纹, cfi: 上次停留位置, at: 记录时刻 }
     * 记录端挂 relocated（滚动时天然触发），只读 cfi + 写盘，不改几何、不调 requestJump
     * → 不参与跳转竞争；恢复端走标准 requestJump，被 last-write-wins 收编。 */
    progress?: { fp: string; cfi: string; at: number };
    [key: string]: any;
}

export interface TocEntry {
    href: string;
    el: HTMLElement;
}

export interface ViewRegEntry {
    idx: number;
    contents: any;
    section: any;
}

export interface ReaderApi {
    path: string;
    root: HTMLElement;
    viewEl: HTMLElement;
    tocFlat: TocEntry[];
    state: ReaderState;
    book?: any;
    rend?: any;
    viewRegistry?: ViewRegEntry[];
    /* 运行期陆续挂上的动态字段（__toastTimer / locTotal / night 等） */
    [key: string]: any;
}
