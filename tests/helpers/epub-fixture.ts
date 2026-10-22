// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A synthetic EPUB builder, for tests only.
 *
 * Written by hand for the same reason the ZIP builder is: if a library
 * produced the fixture, a test failure could mean either side is wrong. This
 * builds the three files the format actually fixes — `mimetype`,
 * `META-INF/container.xml`, and an OPF — so a bug in the importer has to be a
 * bug in the importer.
 *
 * The default shape is a two-chapter book whose OPF lives in `OEBPS/`, which
 * is what most real EPUBs look like. Callers override the pieces they are
 * testing; `opfDir` and `chapterHrefs` exist so the path-resolution cases can
 * put the package file somewhere else.
 */

import { buildZip, bytes, type ZipFixtureEntry } from "./zip-builder.js";

export interface EpubChapter {
  /** Path relative to the OPF's directory, e.g. `chapter1.xhtml`. */
  href: string;
  /** Inner XHTML of `<body>`. */
  body: string;
  /** `<title>` for the chapter document. */
  docTitle?: string;
}

export interface EpubFixtureOptions {
  title?: string;
  author?: string;
  /** Archive directory holding the OPF and, by default, the chapters. */
  opfDir?: string;
  /** File name of the OPF inside `opfDir`. */
  opfName?: string;
  chapters?: readonly EpubChapter[];
  /** Archive path written into container.xml. Defaults to `<opfDir>/<opfName>`. */
  containerPath?: string;
  /**
   * Whether to emit `META-INF/container.xml` at all. Set false to build the
   * "not an EPUB" case.
   */
  includeContainer?: boolean;
  /**
   * Indices into `chapters` giving the spine order. Defaults to declaration
   * order. Set it to something else to prove the importer follows `<spine>`
   * rather than manifest order or filename order.
   */
  spineOrder?: readonly number[];
}

const DEFAULT_CHAPTERS: readonly EpubChapter[] = [
  { href: "chapter1.xhtml", body: "<h1>第一章</h1><p>第一章的正文。</p>", docTitle: "第一章" },
  { href: "chapter2.xhtml", body: "<h1>第二章</h1><p>第二章的正文。</p>", docTitle: "第二章" },
];

function xhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><title>${title}</title></head>
<body>${body}</body>
</html>`;
}

/** The OPF: metadata, a manifest of every chapter, and the spine order. */
function buildOpf(
  options: Required<Pick<EpubFixtureOptions, "title" | "author" | "chapters">>,
  spineOrder: readonly number[],
): string {
  const items = options.chapters
    .map((chapter, i) => `    <item id="ch${i + 1}" href="${chapter.href}" media-type="application/xhtml+xml"/>`)
    .join("\n");
  const refs = spineOrder
    .map((index) => `    <itemref idref="ch${index + 1}"/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-0000</dc:identifier>
    <dc:title>${options.title}</dc:title>
    <dc:creator>${options.author}</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${items}
  </manifest>
  <spine>
${refs}
  </spine>
</package>`;
}

function containerXml(opfPath: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

/** Build an EPUB archive. */
export async function buildEpub(options: EpubFixtureOptions = {}): Promise<Uint8Array> {
  const opfDir = options.opfDir ?? "OEBPS";
  const opfName = options.opfName ?? "content.opf";
  const chapters = options.chapters ?? DEFAULT_CHAPTERS;
  const opfPath = opfDir.length > 0 ? `${opfDir}/${opfName}` : opfName;

  const entries: ZipFixtureEntry[] = [
    // The specification requires `mimetype` to be first and uncompressed. The
    // importer does not check it, but a fixture that violates it would not be
    // a fair test of anything.
    { name: "mimetype", data: bytes("application/epub+zip"), stored: true },
  ];

  if (options.includeContainer ?? true) {
    entries.push({
      name: "META-INF/container.xml",
      data: bytes(containerXml(options.containerPath ?? opfPath)),
    });
  }

  entries.push({
    name: opfPath,
    data: bytes(
      buildOpf(
        {
          title: options.title ?? "测试书籍",
          author: options.author ?? "测试作者",
          chapters,
        },
        options.spineOrder ?? chapters.map((_, i) => i),
      ),
    ),
  });

  const opfBase = opfDir.length > 0 ? `${opfDir}/` : "";
  for (const [i, chapter] of chapters.entries()) {
    entries.push({
      name: `${opfBase}${chapter.href}`.replace(/\/\.\//g, "/"),
      data: bytes(xhtml(chapter.docTitle ?? `第 ${i + 1} 章`, chapter.body)),
    });
  }

  return buildZip(entries);
}
