import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
function stripTags(s) {
  return s.replace(/<[^>]+>/g, "");
}
function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in v) return String(v["#text"]);
  return String(v);
}
function countWords(html) {
  const t = stripTags(html).replace(/\s+/g, " ").trim();
  return t ? t.split(" ").length : 0;
}

function extractChapter(rawHtml, index) {
  const headingMatch = rawHtml.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/is);
  const title = headingMatch ? stripTags(headingMatch[1]).trim() : `Chapter ${index + 1}`;
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : rawHtml;
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "");
  return { title, html: body.trim() };
}

// OPF/container/chapter hrefs are URI references and may be percent-encoded
// (spaces, non-ASCII names, etc). Zip entry names in the archive are not
// encoded, so we must decode before using an href as a lookup key. They may
// also contain "../" segments (common for chapter-relative image/link paths),
// so this also normalizes those away instead of leaving a literal "..".
function normalizeSegments(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}
function resolvePath(dir, href) {
  let decoded;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    decoded = href; // malformed escape sequence - fall back to raw href
  }
  return normalizeSegments(dir + decoded);
}
function dirOf(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}
function isExternalOrData(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href); // scheme prefix e.g. http:, mailto:, data:
}

// Maps common EPUB image media-types to a file extension so covers are
// stored/served with a matching, correct extension instead of a hardcoded one.
function extForMediaType(mediaType) {
  switch (mediaType) {
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    case "image/jpeg":
    default: return "jpg";
  }
}
function guessMediaTypeFromExt(path) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" }[ext] || "application/octet-stream";
}

// Rewrites <img src>/<image xlink:href> targets to a placeholder the Worker
// swaps for a real asset URL once it knows the book id, and rewrites <a href>
// links that point at another chapter in this book into an in-app chapter
// jump instead of a dead relative-file navigation. usedAssets collects every
// image path actually referenced so only those get uploaded to R2.
function rewriteChapterHtml(html, chapterPath, files, chapterPathToOrder, usedAssets) {
  const chapterDir = dirOf(chapterPath);

  const rewriteAssetAttr = (before, attrName, quote, src, after) => {
    if (isExternalOrData(src)) return null;
    const resolved = resolvePath(chapterDir, src);
    if (!files[resolved]) return null; // target not present in the zip - leave as-is (best effort)
    usedAssets.add(resolved);
    return `<${before}${attrName}=${quote}__ASSET__/${encodeURIComponent(resolved)}${quote}${after}>`;
  };

  html = html.replace(/<(img\s[^>]*?)src=(["'])(.*?)\2([^>]*)>/gi, (full, before, quote, src, after) =>
    rewriteAssetAttr(before, "src", quote, src, after) ?? full
  );
  // EPUB3 full-page images are often wrapped as <svg><image xlink:href="..."/></svg>
  html = html.replace(/<(image\s[^>]*?)(xlink:href|href)=(["'])(.*?)\3([^>]*?)(\/?)>/gi, (full, before, attrName, quote, src, after, selfClose) => {
    const rewritten = rewriteAssetAttr(before, attrName, quote, src, after);
    return rewritten ? rewritten.slice(0, -1) + selfClose + ">" : full;
  });

  html = html.replace(/<a\s([^>]*?)href=(["'])(.*?)\2([^>]*)>/gi, (full, before, quote, href, after) => {
    if (!href || href.startsWith("#") || isExternalOrData(href)) {
      if (/^https?:/i.test(href) && !/target=/i.test(before + after)) {
        return `<a ${before}href=${quote}${href}${quote}${after} target="_blank" rel="noopener noreferrer">`;
      }
      return full;
    }
    const [pathPart] = href.split("#");
    const resolved = resolvePath(chapterDir, pathPart);
    const targetOrder = chapterPathToOrder[resolved];
    if (targetOrder === undefined) {
      // Points somewhere we can't resolve to an in-app page (e.g. a split
      // fragment file not in the spine) - defuse it rather than letting it
      // navigate the browser away from the app to a dead relative URL.
      return `<a ${before}href="#" data-dead-link="1"${after}>`;
    }
    return `<a ${before}href="#" data-chapter-idx="${targetOrder}"${after}>`;
  });

  return html;
}

export function parseEpub(buffer) {
  const files = unzipSync(new Uint8Array(buffer));

  const containerXml = strFromU8(files["META-INF/container.xml"]);
  const container = xmlParser.parse(containerXml);
  // Some (rare) multi-rendition epubs have more than one <rootfile>; fast-xml-parser
  // only gives us a plain object (not an array) when there's exactly one, so guard both shapes.
  const rootfileEntry = asArray(container.container.rootfiles.rootfile)[0];
  const opfPath = rootfileEntry["@_full-path"];
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const opfXml = strFromU8(files[opfPath]);
  const opf = xmlParser.parse(opfXml);
  const pkg = opf.package;

  const titleArr = asArray(pkg.metadata?.["dc:title"]);
  const title = textOf(titleArr[0]) || "Untitled";
  const authorArr = asArray(pkg.metadata?.["dc:creator"]);
  const author = textOf(authorArr[0]) || "Unknown Author";

  const manifestItems = asArray(pkg.manifest.item).reduce((acc, item) => {
    acc[item["@_id"]] = {
      href: item["@_href"],
      mediaType: item["@_media-type"],
      properties: item["@_properties"] || "",
    };
    return acc;
  }, {});
  // resolved zip path -> declared media type, used to tag uploaded assets correctly
  const mediaTypeByPath = {};
  for (const item of Object.values(manifestItems)) {
    mediaTypeByPath[resolvePath(opfDir, item.href)] = item.mediaType;
  }

  const spineRefs = asArray(pkg.spine.itemref).map((r) => r["@_idref"]);

  // Cover detection: try EPUB3 first (manifest item with properties="cover-image"),
  // then fall back to the older EPUB2 convention (<meta name="cover" content="ID">).
  // Many modern exports (Calibre, Pandoc, etc.) only include one or the other.
  let coverItem = Object.values(manifestItems).find((item) =>
    item.properties.split(/\s+/).includes("cover-image")
  );
  if (!coverItem) {
    const coverMeta = asArray(pkg.metadata?.meta).find((m) => m["@_name"] === "cover");
    coverItem = coverMeta ? manifestItems[coverMeta["@_content"]] : null;
  }
  const coverPath = coverItem ? resolvePath(opfDir, coverItem.href) : null;
  const coverMediaType = coverItem?.mediaType || null;
  const coverExt = extForMediaType(coverMediaType);

  // pass 1: pull raw title/body/word-count/path for every spine chapter
  const rawChapters = spineRefs
    .map((idref) => manifestItems[idref])
    .filter((item) => item && /html|xhtml/.test(item.mediaType))
    .map((item, i) => {
      const path = resolvePath(opfDir, item.href);
      const raw = files[path] ? strFromU8(files[path]) : "";
      const { title: chapTitle, html } = extractChapter(raw, i);
      return { order: i, title: chapTitle, html, path };
    });

  const chapterPathToOrder = {};
  rawChapters.forEach((c) => { chapterPathToOrder[c.path] = c.order; });

  // pass 2: now that every chapter's path is known, rewrite <img>/<a> targets
  // that point at other chapters or at in-book images
  const usedAssets = new Set();
  const chapters = rawChapters.map((c) => {
    const html = rewriteChapterHtml(c.html, c.path, files, chapterPathToOrder, usedAssets);
    return { order: c.order, title: c.title, html, wordCount: countWords(html), sourcePath: c.path };
  });

  const assets = Array.from(usedAssets).map((path) => ({
    path,
    mediaType: mediaTypeByPath[path] || guessMediaTypeFromExt(path),
  }));

  const totalWords = chapters.reduce((a, c) => a + c.wordCount, 0);

  return { title, author, coverPath, coverMediaType, coverExt, chapters, totalWords, assets };
}
