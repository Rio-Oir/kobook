// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One paragraph, edited in place.
 *
 * ## Why only one block is editable at a time
 *
 * The reader is not an authoring surface; it is a reading surface with a repair
 * hatch. Replacing the whole body with one big editor would put every note
 * underline and every stored offset inside an editor whose document model we
 * do not measure against — the entire annotation system assumes the rendered
 * block text is `paragraph.text` and nothing else. Keeping the editor to the
 * active block means the rest of the DOM, the selection toolbar's coordinate
 * system, and the note anchors keep working untouched.
 *
 * ## Tiptap, not `contenteditable`
 *
 * `contenteditable` looks like a one-line feature and is not: IME composition,
 * undo grouping, paste sanitisation and selection restoration are all load
 * bearing. Tiptap (MIT, ProseMirror) supplies them; this component only fixes
 * the schema to one paragraph plus the five marks the content contract stores.
 */

import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Code from "@tiptap/extension-code";
import Strike from "@tiptap/extension-strike";
import Link from "@tiptap/extension-link";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import type { InlineSpan, Paragraph as ParagraphModel } from "../lib/types";
import {
  paragraphToEditorDoc,
  serializeEditorDoc,
  type EditorNodeJson,
} from "../lib/editing/serialize";

export type EditableBlockProps = {
  paragraph: ParagraphModel;
  saving?: boolean;
  error?: string | null;
  onSave: (edit: { text: string; spans: InlineSpan[] }) => void | Promise<void>;
  onCancel: () => void;
};

function ToolbarButton({
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
      // Keep the editor selection: a normal mousedown moves focus to the button
      // and collapses the range the command is supposed to act on.
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

export function EditableBlock({
  paragraph,
  saving = false,
  error = null,
  onSave,
  onCancel,
}: EditableBlockProps) {
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const saveRef = useRef<() => void>(() => {});

  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
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
      UndoRedo,
      Placeholder.configure({ placeholder: "编辑这一段…" }),
    ],
    content: paragraphToEditorDoc(paragraph),
    // The editor is mounted inside the live reader, never server-rendered.
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class: "gloss-edit-surface",
        spellcheck: "true",
        "aria-label": `编辑第 ${paragraph.index} 段`,
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
    editor?.commands.focus("end");
  }, [editor]);

  function handleSave(): void {
    if (!editor || saving) return;
    const result = serializeEditorDoc(editor.getJSON() as EditorNodeJson);
    if (!result.ok) {
      setLocalError(result.message);
      return;
    }
    setLocalError(null);
    void Promise.resolve(onSave({ text: result.text, spans: result.spans })).catch(
      (reason: unknown) => {
        setLocalError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  }

  saveRef.current = handleSave;

  function setLink(): void {
    if (!editor) return;
    const previous = editor.getAttributes("link").href as string | undefined;
    const answer = window.prompt("链接地址（留空则移除链接）", previous ?? "https://");
    if (answer === null) return;
    const href = answer.trim();
    if (href.length === 0) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    if (!/^(https?:\/\/|\/|#)/i.test(href)) {
      setLocalError("链接必须以 http(s)://、/ 或 # 开头。");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  }

  if (!editor) return null;

  const kind = paragraph.type ?? "paragraph";
  const headingLevel = kind === "heading" ? paragraph.level ?? 1 : 0;
  // A list item must stay an `<li>`: the block is rendered inside the `<ul>`/
  // `<ol>` the reader already emitted, and a `<div>` there would be invalid
  // content the browser reparents. Cast keeps the JSX props typed as a div.
  const Wrapper = (kind === "listItem" ? "li" : "div") as "div";

  return (
    <Wrapper
      data-paragraph-index={paragraph.index}
      data-block-kind={kind}
      data-editing="true"
      className={[
        "gloss-edit-block relative",
        headingLevel > 0 ? `gloss-edit-h${Math.min(6, headingLevel)}` : "",
        kind === "code" ? "gloss-edit-code" : "",
        kind === "listItem" ? "gloss-edit-list-item" : "",
      ].join(" ")}
    >
      <span data-paragraph-marker="">{paragraph.index}</span>

      <div className="relative">
        <div className="gloss-edit-toolbar flex items-center gap-0.5 rounded-lg border border-gloss-border bg-gloss-surface px-1 py-1 shadow-lg">
          <ToolbarButton
            title="粗体"
            active={editor.isActive("bold")}
            disabled={saving}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <strong>B</strong>
          </ToolbarButton>
          <ToolbarButton
            title="斜体"
            active={editor.isActive("italic")}
            disabled={saving}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <em>I</em>
          </ToolbarButton>
          <ToolbarButton
            title="行内代码"
            active={editor.isActive("code")}
            disabled={saving}
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            {"</>"}
          </ToolbarButton>
          <ToolbarButton
            title="删除线"
            active={editor.isActive("strike")}
            disabled={saving}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <span className="line-through">S</span>
          </ToolbarButton>
          <ToolbarButton
            title="链接"
            active={editor.isActive("link")}
            disabled={saving}
            onClick={setLink}
          >
            ↗
          </ToolbarButton>
          <span className="mx-1 h-4 w-px bg-gloss-border" aria-hidden="true" />
          <ToolbarButton
            title="撤销"
            disabled={saving || !editor.can().undo()}
            onClick={() => editor.chain().focus().undo().run()}
          >
            ↶
          </ToolbarButton>
          <ToolbarButton
            title="重做"
            disabled={saving || !editor.can().redo()}
            onClick={() => editor.chain().focus().redo().run()}
          >
            ↷
          </ToolbarButton>
          <span className="mx-1 h-4 w-px bg-gloss-border" aria-hidden="true" />
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
          <p className="mt-1 text-xs text-red-500" role="alert">
            {localError ?? error}
          </p>
        )}
      </div>
    </Wrapper>
  );
}


