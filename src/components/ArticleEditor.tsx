// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Whole-article editor: one surface, all blocks.
 *
 * The reader's earlier repair hatch edited one paragraph at a time. That could
 * not express "move this sentence into its own paragraph", "turn this into a
 * heading", or "delete this block" — and it forced the user to press a pencil
 * per block. Editing is a mode, not a per-block action: this component owns the
 * whole document, and saving replaces the body in one version.
 */

import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Heading from "@tiptap/extension-heading";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Code from "@tiptap/extension-code";
import Strike from "@tiptap/extension-strike";
import Link from "@tiptap/extension-link";
import BulletList from "@tiptap/extension-bullet-list";
import OrderedList from "@tiptap/extension-ordered-list";
import ListItem from "@tiptap/extension-list-item";
import Blockquote from "@tiptap/extension-blockquote";
import CodeBlock from "@tiptap/extension-code-block";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import type { Paragraph as ParagraphModel } from "../lib/types";
import type { DocumentBlock } from "../lib/editing/document";
import { paragraphsToEditorDoc, serializeEditorDocument } from "../lib/editing/document";

export type ArticleEditorProps = {
  paragraphs: readonly ParagraphModel[];
  saving?: boolean;
  error?: string | null;
  onSave: (blocks: DocumentBlock[]) => void | Promise<void>;
  onCancel: () => void;
};

function ToolButton({
  active = false,
  disabled = false,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={[
        "h-7 min-w-7 px-1.5 rounded text-xs leading-none transition-colors",
        active
          ? "bg-gloss-accent/20 text-gloss-accent"
          : "text-gloss-textDim hover:text-gloss-text hover:bg-gloss-text/5",
        disabled ? "opacity-40 pointer-events-none" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function ArticleEditor({
  paragraphs,
  saving = false,
  error = null,
  onSave,
  onCancel,
}: ArticleEditorProps) {
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const saveRef = useRef<() => void>(() => {});

  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
      Bold,
      Italic,
      Code,
      Strike,
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        validate: (href) => /^(https?:\/\/|\/|#)/i.test(href),
      }),
      BulletList,
      OrderedList,
      ListItem,
      Blockquote,
      CodeBlock,
      Image.configure({ inline: false, allowBase64: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      HorizontalRule,
      UndoRedo,
      Placeholder.configure({ placeholder: "开始编辑这篇文章…" }),
    ],
    content: paragraphsToEditorDoc(paragraphs),
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class: "gloss-doc-surface",
        spellcheck: "true",
        "aria-label": "编辑文章",
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (dirty && !window.confirm("放弃这次编辑？")) return true;
          onCancel();
          return true;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          saveRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: () => setDirty(true),
  });

  useEffect(() => {
    editor?.commands.focus("start");
  }, [editor]);

  function handleSave(): void {
    if (!editor || saving) return;
    const result = serializeEditorDocument(editor.getJSON() as never);
    if (!result.ok) {
      setLocalError(result.message);
      return;
    }
    setLocalError(null);
    void Promise.resolve(onSave(result.blocks)).catch((reason: unknown) => {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    });
  }

  saveRef.current = handleSave;

  if (!editor) return null;

  const blockValue = editor.isActive("heading", { level: 1 })
    ? "h1"
    : editor.isActive("heading", { level: 2 })
      ? "h2"
      : editor.isActive("heading", { level: 3 })
        ? "h3"
        : editor.isActive("bulletList")
          ? "bullet"
          : editor.isActive("orderedList")
            ? "ordered"
            : editor.isActive("blockquote")
              ? "quote"
              : editor.isActive("codeBlock")
                ? "code"
                : "paragraph";

  function applyBlock(value: string): void {
    const chain = editor!.chain().focus();
    switch (value) {
      case "h1":
      case "h2":
      case "h3":
        chain.toggleHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run();
        return;
      case "bullet":
        chain.toggleBulletList().run();
        return;
      case "ordered":
        chain.toggleOrderedList().run();
        return;
      case "quote":
        chain.toggleBlockquote().run();
        return;
      case "code":
        chain.toggleCodeBlock().run();
        return;
      default:
        chain.setParagraph().run();
    }
  }

  function setLink(): void {
    const active = editor;
    if (!active) return;
    const previous = active.getAttributes("link").href as string | undefined;
    const answer = window.prompt("链接地址（留空则移除链接）", previous ?? "https://");
    if (answer === null) return;
    const href = answer.trim();
    if (href.length === 0) {
      active.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    if (!/^(https?:\/\/|\/|#)/i.test(href)) {
      setLocalError("链接必须以 http(s)://、/ 或 # 开头。");
      return;
    }
    active.chain().focus().extendMarkRange("link").setLink({ href }).run();
  }

  /**
   * Insert an image, or replace the source of the one the cursor is on.
   *
   * The same allowlist the Reader and the sync route apply: http(s) absolute
   * or root-relative. Refusing here means an edit cannot produce a block the
   * save path would reject.
   */
  function insertImage(): void {
    const active = editor;
    if (!active) return;
    const current = active.getAttributes("image").src;
    const previous = typeof current === "string" && current.length > 0 ? current : "https://";
    const answer = window.prompt("图片地址（http(s):// 或 / 开头）", previous);
    if (answer === null) return;
    const src = answer.trim();
    if (!/^(https?:\/\/|\/)/i.test(src)) {
      setLocalError("图片地址必须以 http(s):// 或 / 开头。");
      return;
    }
    setLocalError(null);
    if (active.isActive("image")) {
      active.chain().focus().updateAttributes("image", { src }).run();
    } else {
      active.chain().focus().setImage({ src }).run();
    }
  }

  function insertTable(): void {
    editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }

  function insertRule(): void {
    editor?.chain().focus().setHorizontalRule().run();
  }

  function toggleTaskList(): void {
    editor?.chain().focus().toggleTaskList().run();
  }

  return (
    <div className="gloss-doc-editor prose gloss-prose">
      <div className="gloss-edit-toolbar sticky top-16 z-10 mb-6 flex flex-wrap items-center gap-1 rounded-lg border border-gloss-border bg-gloss-surface px-2 py-1.5 shadow-lg">
        <select
          value={blockValue}
          disabled={saving}
          aria-label="块类型"
          onChange={(event) => applyBlock(event.target.value)}
          className="h-7 rounded border border-gloss-border bg-transparent px-1 text-xs text-gloss-text"
        >
          <option value="paragraph">正文</option>
          <option value="h1">标题 1</option>
          <option value="h2">标题 2</option>
          <option value="h3">标题 3</option>
          <option value="bullet">无序列表</option>
          <option value="ordered">有序列表</option>
          <option value="quote">引用</option>
          <option value="code">代码块</option>
        </select>
        <span className="mx-1 h-4 w-px bg-gloss-border" aria-hidden="true" />
        <ToolButton title="粗体" active={editor.isActive("bold")} disabled={saving} onClick={() => editor.chain().focus().toggleBold().run()}>
          <strong>B</strong>
        </ToolButton>
        <ToolButton title="斜体" active={editor.isActive("italic")} disabled={saving} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <em>I</em>
        </ToolButton>
        <ToolButton title="行内代码" active={editor.isActive("code")} disabled={saving} onClick={() => editor.chain().focus().toggleCode().run()}>
          {"</>"}
        </ToolButton>
        <ToolButton title="删除线" active={editor.isActive("strike")} disabled={saving} onClick={() => editor.chain().focus().toggleStrike().run()}>
          <span className="line-through">S</span>
        </ToolButton>
        <ToolButton title="链接" active={editor.isActive("link")} disabled={saving} onClick={setLink}>
          ↗
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-gloss-border" aria-hidden="true" />
        <ToolButton
          title="插入图片"
          active={editor.isActive("image")}
          disabled={saving}
          onClick={insertImage}
        >
          图
        </ToolButton>
        <ToolButton title="插入表格" disabled={saving} onClick={insertTable}>
          ▦
        </ToolButton>
        <ToolButton title="插入分隔线" disabled={saving} onClick={insertRule}>
          ―
        </ToolButton>
        <ToolButton
          title="任务列表"
          active={editor.isActive("taskList")}
          disabled={saving}
          onClick={toggleTaskList}
        >
          ☑
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-gloss-border" aria-hidden="true" />
        <ToolButton title="撤销" disabled={saving || !editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
          ↶
        </ToolButton>
        <ToolButton title="重做" disabled={saving || !editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
          ↷
        </ToolButton>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="h-7 px-2 rounded text-xs text-gloss-textDim hover:text-gloss-text hover:bg-gloss-text/5"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="h-7 px-2 rounded text-xs bg-gloss-accent/15 text-gloss-accent hover:bg-gloss-accent/25 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>

      <EditorContent editor={editor} />

      {(localError || error) && (
        <p className="mt-3 text-xs text-red-500" role="alert">
          {localError ?? error}
        </p>
      )}
    </div>
  );
}
