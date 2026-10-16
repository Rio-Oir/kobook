// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { useRef, useState } from "react";
import {
  anonymousDocumentToLocalArticle,
  localArticleKeyFor,
} from "@/lib/articles";
import { useStore } from "@/lib/store";
import { useSession } from "@/lib/session";
import { useModelInfo } from "@/lib/ai";
import {
  importFromText,
  importFromUrlDual,
} from "@/lib/browser-extract";
import { MAX_LOCAL_INPUT_BYTES } from "@/lib/local-import";
import { enqueueArticleSync } from "@/lib/cloud/bridge";
import { currentSessionEpoch } from "@/lib/session-epoch";
import type { ExtractSource } from "@/lib/browser-extract-errors";
import type { ParsedDocument } from "@/lib/types";
import SettingsPanel from "@/components/SettingsPanel";
import ThemeToggle from "@/components/ThemeToggle";

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const saveArticle = useStore((s) => s.saveArticle);
  const modelInfo = useModelInfo();

  const [rawText, setRawText] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Import a local `.txt` / `.md` file.
   *
   * Reuses the same `importFromText` parser as the paste box (no second
   * parser to keep in step) and the same `saveAndOpen` write path, so a
   * file import and a paste produce identical articles, identical
   * `local-<textHash>` keys and identical duplicate handling. The file
   * never leaves the machine: `File.text()` is a local read.
   */
  async function handleFile(file: File) {
    if (loading) return;
    setError(null);
    if (!/\.(md|markdown|txt)$/i.test(file.name)) {
      setError("请拖入 Markdown 或 TXT 文件。");
      return;
    }
    if (file.size > MAX_LOCAL_INPUT_BYTES) {
      setError(`文件超过 ${Math.round(MAX_LOCAL_INPUT_BYTES / 1024 / 1024)} MB 上限。`);
      return;
    }
    try {
      const text = await file.text();
      const title = file.name.replace(/\.(md|markdown|txt)$/i, "");
      const local = importFromText(text, { title });
      if (!local.ok) {
        setError(local.message);
        return;
      }
      saveAndOpen(local.document, "local", undefined, captureSubmitIdentity());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * The submit handler is async. The `authed` snapshot and
   * `currentSessionEpoch()` it reads at the top of `handleSubmit`
   * change the moment the user signs out or switches accounts
   * mid-flight. The URL import alone can take up to 10 s, which
   * is a wide window for a sign-out click. Anything we save or
   * upload after that point must still be tied to the identity
   * the user had when they pressed submit, not the identity they
   * have *now*.
   *
   * `captureSubmitIdentity` returns the frozen tuple the body of
   * `handleSubmit` uses for every write. Returning `null` means
   * "the user is anonymous, never save or upload under any
   * other identity".
   */
  function captureSubmitIdentity(): { ownerUserId: string; epoch: number } | null {
    const user = useSession.getState().user;
    if (!user) return null;
    return { ownerUserId: user.id, epoch: currentSessionEpoch() };
  }

  /**
   * Whether this submit's identity is still the current one.
   *
   * Two jobs, and the `null` case is the first of them:
   *
   *   - **`null` means anonymous.** An anonymous paste is never
   *     uploaded — `enqueueArticleSync` refuses without an owner — so
   *     returning `false` here is what routes an anonymous submit down
   *     the "save locally, do not sync" path.
   *   - **A changed owner or epoch means "do not upload".** The
   *     coordinator checks the same thing at response time; this is the
   *     outer check, and it runs before the request is even built.
   */
  function identityStillCurrent(
    identity: { ownerUserId: string; epoch: number } | null,
  ): boolean {
    if (!identity) return false;
    const user = useSession.getState().user;
    if (!user) return false;
    if (user.id !== identity.ownerUserId) return false;
    if (currentSessionEpoch() !== identity.epoch) return false;
    return true;
  }

  /**
   * Save the parsed document as a local article, jump to the
   * Reader, and (when signed in at submit time) hand the document
   * to the async uploader.
   *
   * Six guarantees this function is the load-bearing place for:
   *
   *   1. **Paste never hits the network.** `importFromText` has
   *      no `fetch` path at all (see `src/lib/local-import.ts`).
   *   2. **URL "success" never falls through to the server.** The
   *      dual extractor returns `source: "browser-jina"` when the
   *      direct channel works; the orchestrator itself never opens
   *      a backend socket for that case.
   *   3. **Sync is fire-and-forget.** `enqueueArticleSync` returns
   *      nothing the Home page needs to wait for.
   *   4. **The article key is the document's textHash, not the
   *      clock.** A user pasting the same text twice lands on the
   *      same `local-<textHash>` id; `saveArticle` overwrites the
   *      same row rather than creating a duplicate, so a refresh
   *      that re-imports the same text does not orphan the notes
   *      the user already anchored to it. "First id wins" only
   *      applies to the remote id: if the article already has a
   *      `remoteId` from an earlier upload, the new paste does
   *      *not* silently rebind to a different server row.
   *   5. **Mid-flight sign-out does not re-parent the article.**
   *      The frozen `submitIdentity` says "this article is user
   *      X's" no matter what the user does after pressing submit.
   *   6. **A later `setArticleRemote` (if sync ever lands) writes
   *      the same remote id the old article already had.** First
   *      id wins: the store's `setArticleRemote` no-ops when an
   *      article already carries a `remoteId`.
   */
  function saveAndOpen(
    document: ParsedDocument,
    source: ExtractSource,
    sourceUrl: string | undefined,
    submitIdentity: { ownerUserId: string; epoch: number } | null,
  ): void {
    const local = anonymousDocumentToLocalArticle(document);
    local.syncDocument = document;
    local.syncSource = source;
    // Keep identical imports and their note/version mapping intact;
    // a formatting-only change (same textHash, different blocks) takes
    // a distinct local key so the previous article keeps its notes and
    // its cloud binding. The rule lives in `localArticleKeyFor` so it
    // is unit-testable without driving the page.
    const existing = useStore.getState().articles[local.id];
    local.id = localArticleKeyFor(document, existing);
    if (existing && local.id === existing.id) {
      // Same key and same blocks: this is a re-view of the same
      // article, so keep the row it already has (including any
      // `remoteId`, notes and highlights anchored to it) rather than
      // replacing it with a fresh `createdAt`.
      Object.assign(local, existing);
    }
    if (sourceUrl) local.url = sourceUrl;
    saveArticle(local);
    window.location.hash = `#/r/${local.id}`;
    if (submitIdentity) {
      enqueueArticleSync(local, document, source, {
        ownerUserId: submitIdentity.ownerUserId,
        epoch: submitIdentity.epoch,
      });
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    // Freeze the identity at submit time. Every async branch below
    // uses this snapshot rather than re-reading the current
    // session, so a sign-out click during a slow URL import cannot
    // re-parent the resulting article or upload to a new account.
    const submitIdentity = captureSubmitIdentity();
    const startedEpoch = currentSessionEpoch();
    const startedOwner = useSession.getState().user?.id ?? null;
    try {
      const link = rawText.match(/https?:\/\/[^\s<>"“”]+/i)?.[0];
      if (link) {
        const normalized = link.replace(/[，。；！？、）\])]+$/u, "");
        if (!/^https?:\/\//.test(normalized)) {
          throw new Error("请输入 http(s) 链接。");
        }
        const result = await importFromUrlDual(normalized, {
          onFallback: (notice) => setError(notice.message),
        });
        // Discard — do not "save it as anonymous instead". A change of owner
        // or epoch (including anon → named) means the result belongs to a
        // session that no longer exists: the sign-out already tore down that
        // account's cache, so materialising the result now would quietly drop
        // a fetched page into whatever space is current. Checked before the
        // save, not just before the upload.
        if (startedEpoch !== currentSessionEpoch() || startedOwner !== (useSession.getState().user?.id ?? null)) return;
        if (result.ok) {
          // Second gate, for the upload only: a `null` identity is the
          // anonymous case, and an anonymous reader's import is saved
          // locally and never synced.
          const stillCurrent = identityStillCurrent(submitIdentity);
          saveAndOpen(
            result.document,
            result.source,
            normalized,
            stillCurrent ? submitIdentity : null,
          );
        } else {
          setError(result.failure.message);
        }
      } else {
        const trimmed = rawText.trim();
        if (!trimmed) throw new Error("请粘贴文章正文");
        const local = importFromText(trimmed);
        if (!local.ok) {
          setError(local.message);
          return;
        }
        saveAndOpen(local.document, "local", undefined, submitIdentity);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12">
      {/* Top bar */}
      <header className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="text-gloss-accent">+</span>
          <span>kobook</span>
          <span className="text-gloss-textDim ml-3">·</span>
          <span className="text-gloss-textDim ml-3">
            {modelInfo.hasKey ? (
              <>
                <span className="text-gloss-accent">♥</span>{" "}
                <span className="text-gloss-textDim">{modelInfo.name}</span>
                <span
                  className={modelInfo.endpointConfirmed ? "text-emerald-500" : "text-amber-500"}
                  title={modelInfo.endpointConfirmed ? "已确认端点" : "需要确认端点"}
                  aria-label={modelInfo.endpointConfirmed ? "已确认端点" : "需要确认端点"}
                >
                  {modelInfo.endpointConfirmed ? "●" : "○"}
                </span>
              </>
            ) : (
              <span className="text-gloss-textDim italic">演示模式</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* The local library is a core feature and is always reachable.
              It belongs to whoever is reading, signed in or not: an
              anonymous reader must be able to find the articles they saved,
              so this link is never gated on a session. */}
          <a href="#/library" data-testid="library-link" className="text-sm text-gloss-textDim hover:text-gloss-text transition-colors">我的文章</a>
          <ThemeToggle />
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-gloss-textDim hover:text-gloss-text p-1 text-base"
            title="设置"
          >
            ⚙
          </button>
        </div>
      </header>

      {/* Hero */}
      <main className="max-w-3xl w-full text-center animate-fade-in">
        <h1 className="font-serif text-5xl md:text-6xl leading-[1.1] tracking-tight">
          选中一段文字，
          <br />
          <span className="inline-block px-2 bg-gloss-accent/15 border-b-2 border-gloss-accent">
            读懂每一个疑问。
          </span>
        </h1>

        <form
          onSubmit={handleSubmit}
          className="mt-12 flex flex-col items-center gap-4"
        >
          <div
            className="w-full max-w-xl rounded-xl bg-gloss-surface border border-gloss-border focus-within:border-gloss-accent/50 transition-colors p-4"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) void handleFile(file);
            }}
          >
            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              aria-label="文章链接或正文"
              placeholder="粘贴文章链接，或直接粘贴正文…"
              rows={5}
              className="block w-full min-w-0 bg-transparent outline-none resize-y text-gloss-text placeholder:text-gloss-textDim"
              required
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void handleFile(file);
                }}
                data-testid="file-import-input"
                className="hidden"
              />
              <button
                type="button"
                disabled={loading}
                onClick={() => fileInputRef.current?.click()}
                aria-label="导入 Markdown 或 TXT 文件"
                title="拖入或选择 Markdown / TXT 文件"
                className="p-2 rounded-lg text-gloss-textDim hover:text-gloss-text hover:bg-gloss-text/5 transition-colors disabled:opacity-40"
              >
                <svg aria-hidden="true" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9" />
                </svg>
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-gloss-text text-gloss-bg text-sm font-medium hover:bg-gloss-text/85 transition-colors disabled:opacity-40"
              >
                {loading ? "正在导入…" : "开始阅读 →"}
              </button>
            </div>
          </div>
        </form>

        {error && (
          <div className="mt-6 max-w-xl mx-auto px-4 py-3 rounded-lg bg-gloss-accent/10 border border-gloss-accent/30 text-sm text-gloss-accent">
            {error}
          </div>
        )}

        {/* Three-step intro */}
        <div className="mt-20 grid grid-cols-3 gap-6 text-left max-w-2xl mx-auto">
          {[
            {
              n: "1",
              title: "导入文章",
              body: "粘贴网页链接或文章正文。",
            },
            {
              n: "2",
              title: "选中文字",
              body: "一个词、一句话或一段文字。",
            },
            {
              n: "3",
              title: "解释与提问",
              body: "在侧栏阅读回答，并查看原文引用。",
            },
          ].map((step) => (
            <div key={step.n}>
              <div className="text-gloss-accent font-mono text-xs mb-2">
                {step.n}
              </div>
              <div className="font-medium text-sm">{step.title}</div>
              <div className="text-xs text-gloss-textDim mt-1">{step.body}</div>
            </div>
          ))}
        </div>
      </main>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
