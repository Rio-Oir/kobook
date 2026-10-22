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
import { importFromFile } from "@/lib/import";
import { classifyImportInput } from "@/lib/import-input";
import { enqueueArticleSync } from "@/lib/cloud/bridge";
import { ensureArticleTags } from "@/lib/tagging";
import TopBarMenu from "@/components/TopBarMenu";
import { currentSessionEpoch } from "@/lib/session-epoch";
import type { ExtractSource } from "@/lib/browser-extract-errors";
import type { ParsedDocument } from "@/lib/types";

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveArticle = useStore((s) => s.saveArticle);
  const modelInfo = useModelInfo();

  const [rawText, setRawText] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * Guards a second file import while one is in flight.
   *
   * `loading` is React state, so two events in the same tick would both read
   * the value from the current render and both get through. A 50 MB PDF takes
   * long enough for a double-drop to be an ordinary accident, and the cost is
   * a duplicated article plus two full parses, so the guard is a ref.
   */
  const fileBusyRef = useRef(false);

  /**
   * Import a local file: PDF, EPUB, DOCX, HTML, Markdown or plain text.
   *
   * The format is decided by `sniffFormat` from the bytes, not from the name —
   * a `.txt` that is really HTML is read as HTML, and a PDF is recognised
   * however it is named. The name is only consulted when the bytes are
   * inconclusive, and only ever as a *fallback* title: a book carries its own
   * (the EPUB's OPF, the PDF's first heading, the document's `<title>`), and
   * the name on disk is frequently a catalogue number.
   *
   * Two things this deliberately does *not* do any more, both of which were
   * bugs rather than simplifications:
   *
   *  - It does not gate on the extension. The old whitelist was
   *    `.md|.markdown|.txt`, which refused every PDF before it was ever read.
   *  - It does not gate on `file.size` against the paste ceiling. A PDF is
   *    routinely 5–50 MB while its text layer is a few hundred KB, so a single
   *    byte budget reports the wrong reason for refusing. The importer carries
   *    two separate ceilings — `MAX_FILE_BYTES` on the container and
   *    `MAX_TEXT_BYTES` on the extracted text — and checks the container's
   *    against `file.size` first so an oversized file is refused without being
   *    read.
   *
   * Failure is a value, not an exception, and each code already carries a
   * message written for this surface, so there is no code→string table here to
   * drift out of step with the importer.
   *
   * A successful import does *not* announce the encoding it guessed, even
   * though `FileImportSuccess` reports it. The only surface that could say so
   * is this page, and `saveAndOpen` navigates away from it in the same tick —
   * a notice set here is never painted. Saying it in the reader instead would
   * mean persisting an encoding on the article, which turns a one-off advisory
   * about one import into a permanent label on every future open.
   */
  async function handleFile(file: File) {
    if (fileBusyRef.current) return;
    fileBusyRef.current = true;
    setError(null);
    setLoading(true);
    try {
      const result = await importFromFile(file);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await saveAndOpen(result.document, "local", undefined, captureSubmitIdentity());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      fileBusyRef.current = false;
      setLoading(false);
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
  async function saveAndOpen(
    document: ParsedDocument,
    source: ExtractSource,
    sourceUrl: string | undefined,
    submitIdentity: { ownerUserId: string; epoch: number } | null,
  ): Promise<void> {
    const { article, paragraphs } = anonymousDocumentToLocalArticle(document);
    article.syncSource = source;
    // Keep identical imports and their note/version mapping intact;
    // a formatting-only change (same textHash, different blocks) takes
    // a distinct local key so the previous article keeps its notes and
    // its cloud binding. The rule lives in `localArticleKeyFor` so it
    // is unit-testable without driving the page.
    const existing = useStore.getState().articles[article.id];
    article.id = localArticleKeyFor(document, existing);
    if (existing && article.id === existing.id) {
      // Same key and same blocks: this is a re-view of the same
      // article, so keep the row it already has (including any
      // `remoteId`, notes and highlights anchored to it) rather than
      // replacing it with a fresh `createdAt`.
      Object.assign(article, existing);
    }
    if (sourceUrl) article.url = sourceUrl;
    // Awaited, so a body the disk refused is reported here rather than
    // discovered by the reader after a refresh. The record and the in-memory
    // body are installed synchronously inside `saveArticle`, so navigating
    // afterwards still finds the text.
    await saveArticle(article, paragraphs);
    const saved = useStore.getState().articles[article.id];
    // Tags are a background enhancement, never part of the import: the call
    // is not awaited, and `ensureArticleTags` itself skips silently when no
    // key is configured or the body is not on disk. The Reader's on-open
    // effect is the second trigger, which is what makes "import now, add the
    // key later, tag on next read" work.
    void ensureArticleTags(article.id).catch(() => undefined);
    window.location.hash = `#/r/${article.id}`;
    if (submitIdentity && saved) {
      enqueueArticleSync(saved, document, source, {
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
      // Which half of the box this paste belongs to is a product rule with
      // its own tests (`src/lib/import-input.ts`), not a regex to keep in
      // step here. It answers three questions at once: is this one link,
      // is it a link inside shared text, or is it article text — and it
      // defaults the scheme for a bare `example.com/a` paste, which is what
      // makes that affordance work instead of silently becoming a one-line
      // article. A paste it calls text never reaches the network: the branch
      // below is `importFromText`, which has no fetch in it at all.
      const input = classifyImportInput(rawText);
      if (input.kind === "url") {
        // `input.url` is absolute by now; the extractor's own gate still
        // decides whether it may be fetched (http(s) only, no credentials).
        const result = await importFromUrlDual(input.url, {
          onFallback: (notice) => setError(notice.message),
        });
        // 丢弃, 不是"改成不登录再保存". The rule is "URL owner+epoch
        // 变化直接丢弃（包括 anon→named）": the sign-out already tore
        // down the account's cache, so materialising the result now
        // would quietly drop a fetched page into whatever space is
        // current. Checked before the save, not just before the upload.
        if (startedEpoch !== currentSessionEpoch() || startedOwner !== (useSession.getState().user?.id ?? null)) return;
        if (result.ok) {
          // Second gate, for the upload only: a `null` identity is the
          // anonymous case, and an anonymous reader's import is saved
          // locally and never synced.
          const stillCurrent = identityStillCurrent(submitIdentity);
          await saveAndOpen(
            result.document,
            result.source,
            input.url,
            stillCurrent ? submitIdentity : null,
          );
        } else {
          setError(result.failure.message);
        }
      } else {
        const trimmed = input.text;
        if (!trimmed) throw new Error("请粘贴文章正文");
        const local = importFromText(trimmed);
        if (!local.ok) {
          setError(local.message);
          return;
        }
        await saveAndOpen(local.document, "local", undefined, submitIdentity);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    // `justify-center` used to centre the hero *as a block*, which put the
    // composer 13px below the viewport's centre line — the box is not the
    // block's visual centre, so centring the block does not centre the box.
    // `main` is `flex-1` in a box with symmetric padding, so its own centre
    // line is the viewport's, and the grid below does the centring per row.
    // The padding has to match on both sides or the centre line drifts.
    <div className="min-h-screen flex flex-col px-6 pt-24 pb-24">
      {/* Top bar */}
      <header className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="text-gloss-accent">+</span>
          <span>KoBook</span>
          {modelInfo.hasKey && (
            <>
              <span className="text-gloss-textDim ml-3">·</span>
              <span className="text-gloss-textDim ml-3">
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
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* The local library is a base feature and is always reachable.
              It used to be shown only to a signed-in reader or in the free
              build, which meant an anonymous reader in the account build had
              articles they could not find again. */}
          <a href="#/library" data-testid="library-link" className="text-sm text-gloss-textDim hover:text-gloss-text transition-colors">我的文章</a>
          <TopBarMenu showLibrary={false} />
        </div>
      </header>

      {/* Hero. `minmax(0,1fr)` rather than bare `1fr`: a bare fr row still has an
          auto floor at its content's height, so a tall title and a short
          intro would give the two rows different heights and push the middle
          row off centre. `minmax(0,…)` makes them exactly equal at any size. */}
      <main className="flex-1 w-full max-w-3xl mx-auto grid grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-y-12 text-center animate-fade-in">
        <h1 className="self-end font-serif text-5xl md:text-6xl leading-[1.1] tracking-tight">
          选中一段文字，
          <br />
          <span className="inline-block px-2 bg-gloss-accent/15 border-b-2 border-gloss-accent">
            读懂每一个疑问。
          </span>
        </h1>

        <div className="self-center flex flex-col items-center gap-4">
          <form
            onSubmit={handleSubmit}
            className="w-full flex flex-col items-center"
          >
          {/* `max-w-[588.667px]` is sized backwards from the design
              reference rather than picked from the scale: 574.667 of content
              + 6 of padding on each side + the 1px border on each side. */}
          <div
            className="gloss-import-composer flex items-center gap-2 w-full max-w-[588.667px] rounded-xl bg-gloss-surface border p-1.5"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) void handleFile(file);
            }}
          >
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.mdown,.txt,.text,.html,.htm,.xhtml,.epub,.docx,.pdf,text/markdown,text/plain,text/html,application/xhtml+xml,application/epub+zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
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
                aria-label="导入 PDF、EPUB、DOCX、HTML、Markdown 或 TXT 文件"
                title="拖入或选择 PDF / EPUB / DOCX / HTML / Markdown / TXT 文件"
                className="shrink-0 p-2 rounded-lg text-gloss-textDim hover:text-gloss-text hover:bg-gloss-text/5 transition-colors disabled:opacity-40"
              >
                <svg aria-hidden="true" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9" />
                </svg>
              </button>
              <textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                aria-label="文章链接或正文"
                placeholder="粘贴文章链接，或直接粘贴正文…"
                rows={1}
                className="block flex-1 min-w-0 h-12 py-3 bg-transparent outline-none resize-none text-gloss-text placeholder:text-gloss-textDim"
                required
              />
              <button
                type="submit"
                disabled={loading}
                className="shrink-0 whitespace-nowrap px-4 py-2 rounded-lg bg-gloss-text text-gloss-bg text-sm font-medium hover:bg-gloss-text/85 transition-colors disabled:opacity-40"
              >
                {loading ? "正在导入…" : "开始阅读 →"}
              </button>
          </div>
          </form>

          {error && (
            <div className="w-full max-w-xl px-4 py-3 rounded-lg bg-gloss-accent/10 border border-gloss-accent/30 text-sm text-gloss-accent">
              {error}
            </div>
          )}
        </div>

        {/* Three-step intro. `mt-12` is the only thing separating these from
            the composer above them now — the grid's own `gap-y-12` used to do
            that, and the extra room reads better than the grid default here.
            Each step is outlined with `gloss-border`, the hairline token whose
            documented use is card outlines; the composer deliberately does not
            use it, because that box is a control and needs the heavier
            `gloss-import-composer` border instead. `grid-cols-1` below `sm`:
            the border and the padding together take 32px out of what a phone
            leaves per column, which is enough to break a four-character title
            mid-word. */}
        <div className="self-start mt-12 grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 text-left max-w-2xl mx-auto w-full">
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
            <div key={step.n} className="gloss-step-card rounded-xl border border-gloss-border p-4">
              <div className="text-gloss-accent font-mono text-xs mb-2">
                {step.n}
              </div>
              <div className="font-medium text-sm">{step.title}</div>
              <div className="text-xs text-gloss-textDim mt-1">{step.body}</div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
