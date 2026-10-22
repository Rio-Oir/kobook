// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 编辑器 chunk 的加载器：带超时、可见错误与重试。
 *
 * 为什么不是 `React.lazy` + `<Suspense>`：
 *
 * lazy 的失败只有两种结局——模块到了就渲染，或者抛错——而**请求一直不返回**
 * 时，Suspense 会永远停在 fallback 上。开发环境里这并不罕见：dev server 正在
 * 重建模块图、页面早于服务起好、浏览器侧的 Service Worker 或扩展把请求挂住，
 * 都会让 `import()` 的 promise 既不 resolve 也不 reject。用户看到的就是
 * 「正在载入编辑器…」永远停着，页面上没有任何线索，也没法自救。
 *
 * 这里把这件事变成三个明确的状态：loading / ready / error（含超时），
 * error 里给「重试」和「刷新页面」，因此任何一次挂住都会在超时后变成
 * 一条可读的错误，而不是一个骗人的进度提示。
 *
 * chunk 仍然按需加载：`import()` 留在函数里，Tiptap 不会进阅读首屏的包。
 */

import { useEffect, useState, type ComponentType } from "react";
import type { ArticleEditorProps } from "./ArticleEditor";

export type EditorComponent = ComponentType<ArticleEditorProps>;

export type EditorChunkState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; Component: EditorComponent }
  | { status: "error"; message: string };

/**
 * 超过这个时间就当作「挂住了」。
 *
 * 正常情况这个 chunk 在本地 dev 下 1 秒内到、生产构建下是一次同源文件请求；
 * 10 秒已经足够排除慢机器和冷启动，再久就只是在骗用户。
 */
export const EDITOR_CHUNK_TIMEOUT_MS = 10_000;

/**
 * 拉一次编辑器 chunk。
 *
 * 不用 `AbortController`：动态 `import()` 没法中止，超时后原来的请求还会继续，
 * 但这里只关心「界面什么时候该离开 loading」。如果它之后真的到了，下一次
 * 重试会立刻命中模块缓存。
 */
export function loadEditorChunk(): Promise<EditorComponent> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `编辑器资源在 ${EDITOR_CHUNK_TIMEOUT_MS / 1000} 秒内没有加载完成——` +
            "通常是开发服务器正在重启或浏览器缓存卡住了。",
        ),
      );
    }, EDITOR_CHUNK_TIMEOUT_MS);

    import("@/components/ArticleEditor").then(
      (module) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(module.ArticleEditor);
      },
      (reason: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          reason instanceof Error
            ? reason
            : new Error(`编辑器资源加载失败：${String(reason)}`),
        );
      },
    );
  });
}

/**
 * 进入编辑模式时才加载编辑器，并把加载状态交给调用方渲染。
 *
 * `active` 为 false 时回到 idle，这样退出编辑再进入会重新走一次加载（通常是
 * 命中模块缓存，瞬时完成）。
 *
 * 这里没有「重试导入」：浏览器会按 URL 缓存动态 import 的失败结果，同一个
 * 地址再 `import()` 一次会立刻以同一个错误失败。真正可靠的重试是重新加载
 * 页面（见 Reader 里的按钮），所以这个 hook 只负责报状态，不假装能自愈。
 */
export function useEditorChunk(active: boolean): EditorChunkState {
  const [state, setState] = useState<EditorChunkState>({ status: "idle" });

  useEffect(() => {
    if (!active) {
      setState({ status: "idle" });
      return;
    }
    let alive = true;
    setState({ status: "loading" });
    loadEditorChunk().then(
      (Component) => {
        if (alive) setState({ status: "ready", Component });
      },
      (reason: unknown) => {
        if (!alive) return;
        setState({
          status: "error",
          message: reason instanceof Error ? reason.message : String(reason),
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [active]);

  return state;
}
