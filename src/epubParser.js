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

// OPF/container hrefs are URI references and may be percent-encoded
// (spaces, non-ASCII names, etc). Zip entry names in the archive are not
// encoded, so we must decode before using an href as a lookup key.
function resolvePath(dir, href) {
  let decoded;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    decoded = href; // malformed escape sequence - fall back to raw href
  }
  return dir + decoded;
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

  const chapters = spineRefs
    .map((idref) => manifestItems[idref])
    .filter((item) => item && /html|xhtml/.test(item.mediaType))
    .map((item, i) => {
      const path = resolvePath(opfDir, item.href);
      const raw = files[path] ? strFromU8(files[path]) : "";
      const { title: chapTitle, html } = extractChapter(raw, i);
      return { order: i, title: chapTitle, html, wordCount: countWords(html), sourcePath: path };
    });

  const totalWords = chapters.reduce((a, c) => a + c.wordCount, 0);

  return { title, author, coverPath, coverMediaType, coverExt, chapters, totalWords };
}
