// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Article library.
 *
 * The library **is** the local store. Rows come from `useStore().articles`,
 * opening a row is `#/r/<id>`, deleting a row is `store.deleteArticle`
 * (article + its notes + its highlights). No request is made — there is no
 * server-side list to read.
 *
 * That is a design decision rather than an omission: a reader who installs
 * this application and signs into nothing still gets a library that works
 * with no network and no database. A deployment that adds a hosted view can
 * install one through the adapter seam; what stays here is the list that
 * always works, and the store shape it reads is the same one the reader
 * writes, so there is one model of "what an article is" rather than two.
 */

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import {
  dismissLegacyNotice,
  downloadLegacyRaw,
  importLegacyIntoStore,
  isLegacyNoticeDismissed,
  readLegacySummary,
} from "@/lib/legacy-local-free";
import type { Article } from "@/lib/types";
import ThemeToggle from "@/components/ThemeToggle";
import { downloadLocalBackup, restoreLocalBackup, validateLocalBackup } from '@/lib/local-backup';

/** Render the local store's epoch milliseconds as a short date. */
function formatCreatedAt(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function Library() {
  const saveArticle = useStore((s) => s.saveArticle);
  const localArticlesById = useStore((s) => s.articles);
  const deleteLocalArticle = useStore((s) => s.deleteArticle);
  const [pendingLocalDelete, setPendingLocalDelete] = useState<Article | null>(null);
  // Read once on mount: the summary is a snapshot of a space this page never
  // writes to, so there is nothing to re-read after an import (the import
  // reads the blob again itself).
  const [legacy] = useState(() => readLegacySummary());
  const [legacyNoticeHidden, setLegacyNoticeHidden] = useState(() => isLegacyNoticeDismissed());
  const [legacyMessage, setLegacyMessage] = useState<string | null>(null);

  // The library is the local store, in import order (newest first). Derived on
  // render rather than copied into state so a delete or a new import elsewhere
  // in the SPA cannot leave this page showing a stale list.
  const localArticles = useMemo(
    () => Object.values(localArticlesById).sort((a, b) => b.createdAt - a.createdAt),
    [localArticlesById],
  );

  return (
    <div className="min-h-screen flex flex-col px-6 py-12 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-10">
        <a href="#/" className="flex items-center gap-2 text-sm font-medium hover:opacity-80">
          <span className="text-gloss-accent">+</span>
          <span>kobook</span>
        </a>
        <div className="flex items-center gap-3">
          <ThemeToggle />
        </div>
      </header>

      <h1 className="font-serif text-3xl mb-2">我的文章</h1>
      <p className="text-sm text-gloss-textDim mb-8">
        文章保存在这台设备上，不需要账号。清除浏览器数据会丢失，请定期备份。
      </p>

      <section className="mb-6 flex flex-wrap gap-3 text-sm">
        <button data-testid="backup-download" onClick={() => {
          try { downloadLocalBackup(); } catch { setLegacyMessage('备份失败，请检查本机数据。'); }
        }}>下载本机备份</button>
        <label className="cursor-pointer">从备份恢复
          <input data-testid="backup-restore" type="file" accept=".json,application/json" className="sr-only" onChange={async event => {
            const file=event.target.files?.[0]; event.target.value=''; if(!file)return;
            try {
              if(file.size>20*1024*1024) throw new Error('备份超过20 MB上限。');
              const raw=await file.text(), data=validateLocalBackup(raw);
              if(!window.confirm(`恢复 ${Object.keys(data.articles).length} 篇文章及笔记？只新增，相同记录跳过；冲突时整批取消。`))return;
              restoreLocalBackup(raw); setLegacyMessage('本机备份已恢复，已有内容已保留。');
            } catch { setLegacyMessage('恢复失败：格式无效、记录冲突或存储空间不足；未覆盖已有内容。'); }
          }}/>
        </label>
      </section>
      {legacyMessage && <p role="status" className="mb-4 text-sm">{legacyMessage}</p>}

      {legacy.present && !legacyNoticeHidden && (
        <section
          data-testid="legacy-notice"
          className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
        >
          <p className="font-medium mb-1">检测到旧版独立阅读器的本机数据</p>
          <p className="text-gloss-textDim">
            旧版本机数据中包含：
            {legacy.unreadable ? (
              <>未能读取（{legacy.unreadable}），仍可下载原始文件保留。</>
            ) : (
              <>
                {legacy.articles} 篇文章 · {legacy.highlights} 条划线 · {legacy.notes} 条旧笔记 ·{" "}
                {(legacy.bytes / 1024).toFixed(1)} KB。
              </>
            )}
          </p>
          <p className="text-gloss-textDim mt-1">
            旧空间不会被删除或覆盖。要做迁移请先下载原始备份，再选择是否一次性导入到当前空间（只增不减）。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="legacy-download"
              onClick={() => {
                const r = downloadLegacyRaw();
                setLegacyMessage(
                  r.ok ? `已下载原始备份（${(r.bytes / 1024).toFixed(1)} KB）：${r.filename}` : r.message,
                );
              }}
              className="px-3 py-1.5 rounded-lg border border-amber-500/50 hover:bg-amber-500/10 text-xs"
            >
              下载原始备份
            </button>
            {!legacy.unreadable && (
              <button
                type="button"
                data-testid="legacy-import"
                onClick={() => {
                  const confirmed = window.confirm(
                    "把这批旧数据一次性导入当前空间？\n\n" +
                      "· 只新增，不会清空你现在的内容；\n" +
                      "· 旧空间与它的原始文件都保留不动；\n" +
                      "· 旧的自由笔记会以「本机自由笔记」的标注出现，不会被伪装成 AI 回答。",
                  );
                  if (!confirmed) return;
                  const r = importLegacyIntoStore();
                  setLegacyMessage(r.message);
                }}
                className="px-3 py-1.5 rounded-lg bg-gloss-text text-gloss-bg text-xs font-medium"
              >
                一次性导入到当前空间
              </button>
            )}
            <button
              type="button"
              data-testid="legacy-dismiss"
              onClick={() => {
                dismissLegacyNotice();
                setLegacyNoticeHidden(true);
              }}
              className="px-3 py-1.5 rounded-lg text-xs text-gloss-textDim hover:text-gloss-text"
            >
              暂时不处理
            </button>
          </div>
          {legacyMessage && (
            <p role="status" data-testid="legacy-message" className="mt-2 text-xs text-gloss-text">
              {legacyMessage}
            </p>
          )}
        </section>
      )}

      {localArticles.length === 0 && (
        <div className="rounded-lg border border-dashed border-gloss-border p-10 text-center">
          <p className="text-sm text-gloss-textDim mb-4">还没有保存的文章。</p>
          <a
            href="#/"
            className="inline-block px-4 py-1.5 rounded-lg bg-gloss-text text-gloss-bg text-sm font-medium hover:bg-gloss-text/85 transition-colors"
          >
            导入一篇
          </a>
        </div>
      )}

      {localArticles.length > 0 && (
        <ul className="divide-y divide-gloss-border" data-testid="local-library-list">
          {localArticles.map((a) => (
            <li
              key={a.id}
              className="py-4 flex items-center justify-between gap-4"
              data-testid="local-library-item"
              data-article-id={a.id}
            >
              <button
                type="button"
                onClick={() => {
                  // Already in the store — opening is a hash hop, not a fetch.
                  saveArticle(a);
                  window.location.hash = `#/r/${a.id}`;
                }}
                className="flex-1 min-w-0 text-left hover:opacity-80"
              >
                <div className="font-medium truncate">{a.title || "(无标题)"}</div>
                <div className="text-xs text-gloss-textDim mt-1">
                  {a.paragraphs.length} 段 · 导入于 {formatCreatedAt(a.createdAt)}
                  {a.url ? ` · ${a.url}` : ""}
                </div>
              </button>
              <button
                type="button"
                onClick={() => setPendingLocalDelete(a)}
                className="text-xs text-gloss-textDim hover:text-gloss-accent"
                aria-label={`删除文章 ${a.title}`}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}

      {pendingLocalDelete && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="local-delete-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          <div className="bg-gloss-surface border border-gloss-border rounded-xl p-6 max-w-sm w-full mx-4">
            <h2 className="font-medium mb-2">删除这篇文章？</h2>
            <p className="text-sm text-gloss-textDim mb-6">
              《{pendingLocalDelete.title}》以及它的划线、笔记会一起从这台设备上移除。此操作不可撤销，
              如需保留请先导出备份。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingLocalDelete(null)}
                className="px-3 py-1.5 text-sm rounded-lg border border-gloss-border hover:border-gloss-textDim"
              >
                取消
              </button>
              <button
                type="button"
                data-testid="local-delete-confirm"
                onClick={() => {
                  deleteLocalArticle(pendingLocalDelete.id);
                  setPendingLocalDelete(null);
                }}
                className="px-3 py-1.5 text-sm rounded-lg bg-gloss-accent text-white hover:opacity-90"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
