// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Minimal, hand-assembled PDFs for the browser import gate.
 *
 * Why not a real book: the gate has to run from a clean checkout with no
 * fixtures to license or ship, and a 5 MB sample would tell us nothing extra.
 * What this file has to produce is a *valid* PDF whose text layer pdf.js can
 * read, because the failure this gate exists for is not "the parser is wrong"
 * — the parser has unit tests — it is "the worker never loaded".
 *
 * ## The bug this is aimed at
 *
 * pdf.js runs in a worker. `pdfjs.GlobalWorkerOptions.workerSrc` has to point
 * at a file that actually exists in the built artifact. The first attempt used
 * Vite's `?url` import, which folds the worker into a chunk and emits no file
 * at all: the build succeeded, the size looked plausible, and nothing failed
 * until a user opened their first PDF, at which point the import hung. A
 * fixture with no text would not catch that; a fixture with text that has to
 * arrive in the reader does, because extracting it requires the worker.
 *
 * ## The two encodings, and why both
 *
 * `buildAsciiPdf` uses a standard Type1 font and literal strings — the shape a
 * PDF takes when a Western tool wrote it. `buildCjkPdf` uses a Type0 font with
 * `Identity-H` encoding and a `ToUnicode` CMap, which is what a Chinese PDF
 * looks like: the bytes in the content stream are glyph indices, and the only
 * thing that turns them back into characters is the CMap. If the CMap is
 * dropped or mis-read, the text arrives as garbage rather than as an error,
 * which is exactly the silent failure worth a gate.
 *
 * Neither path needs an embedded font program. Text extraction reads the
 * encoding tables, not the glyph outlines, so the descendant font can be a
 * descriptor with no `FontFile` — pdf.js warns and carries on.
 */

const encoder = new TextEncoder();

function bytes(text) {
  return encoder.encode(text);
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/**
 * Lay out numbered objects into a file with a correct cross-reference table.
 *
 * The offsets have to be real. pdf.js can repair a broken xref, so a fixture
 * with wrong offsets would still usually pass — and would then be testing the
 * repair path instead of the normal one.
 */
function assemble(objects) {
  const chunks = [];
  let offset = 0;
  const push = (part) => {
    chunks.push(part);
    offset += part.length;
  };

  // The binary comment on line 2 is what tells tools the file is binary.
  push(bytes("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"));

  const offsets = objects.map((body, index) => {
    const at = offset;
    push(bytes(`${index + 1} 0 obj\n`));
    push(body);
    push(bytes("\nendobj\n"));
    return at;
  });

  const startxref = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) xref += `${String(at).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  push(bytes(xref));

  return concat(...chunks);
}

function streamObject(data) {
  const body = typeof data === "string" ? bytes(data) : data;
  return concat(bytes(`<< /Length ${body.length} >>\nstream\n`), body, bytes("\nendstream"));
}

/** The catalog, page tree and single page, shared by both builders. */
function pageObjects(fontObject, contentsObject) {
  return [
    bytes("<< /Type /Catalog /Pages 2 0 R >>"),
    bytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    bytes(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        `/Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentsObject} 0 R >>`,
    ),
  ];
}

/** Escape a literal string for a content stream. */
function literal(text) {
  return text.replace(/[\\()]/g, (ch) => `\\${ch}`);
}

/**
 * A one-page PDF of Western text, one line per entry, top to bottom.
 *
 * Returns bytes, matching what `importFromFileBytes` and `File` both take.
 */
export function buildAsciiPdf(lines) {
  const content = lines
    .map((line, index) => `BT /F1 24 Tf 72 ${700 - index * 40} Td (${literal(line)}) Tj ET`)
    .join("\n");
  return assemble([
    ...pageObjects(4, 5),
    bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    streamObject(content),
  ]);
}

/**
 * A one-page PDF of text that only a `ToUnicode` CMap can decode.
 *
 * Each distinct character gets a one-based code, so the content stream is a run
 * of two-byte codes that mean nothing on their own. A reader that ignores the
 * CMap gets mojibake or nothing; one that honours it gets the lines back.
 */
export function buildCjkPdf(lines) {
  const codes = new Map();
  for (const line of lines) {
    for (const ch of line) if (!codes.has(ch)) codes.set(ch, codes.size + 1);
  }

  const toUnicode = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${codes.size} beginbfchar`,
    ...[...codes].map(
      ([ch, code]) =>
        `<${code.toString(16).padStart(4, "0")}> <${ch.codePointAt(0).toString(16).padStart(4, "0")}>`,
    ),
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");

  const content = lines
    .map((line, index) => {
      const hex = [...line]
        .map((ch) => codes.get(ch).toString(16).padStart(4, "0"))
        .join("");
      return `BT /F1 24 Tf 72 ${700 - index * 40} Td <${hex}> Tj ET`;
    })
    .join("\n");

  return assemble([
    ...pageObjects(4, 5),
    // Type0 with Identity-H: the codes in the content stream are the CIDs, and
    // `ToUnicode` is the only thing that maps them back to characters.
    bytes(
      "<< /Type /Font /Subtype /Type0 /BaseFont /Song /Encoding /Identity-H " +
        "/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
    ),
    streamObject(content),
    bytes(
      // A CIDFont dictionary is `/Type /Font` with `/Subtype /CIDFontType0` —
      // not `/Type /CIDFontType0`. Getting this wrong produces no error at all
      // at the PDF level; pdf.js reads the descendant font's `Subtype`, finds
      // none, and reports "invalid font Subtype", after which the page has zero
      // text items and the import looks like a scanned PDF.
      "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Song " +
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> " +
        "/FontDescriptor 8 0 R /DW 1000 >>",
    ),
    streamObject(toUnicode),
    bytes(
      "<< /Type /FontDescriptor /FontName /Song /Flags 4 /FontBBox [0 -200 1000 900] " +
        "/ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>",
    ),
  ]);
}
