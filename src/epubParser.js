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

export function parseEpub(buffer) {
  const files = unzipSync(new Uint8Array(buffer));

  const containerXml = strFromU8(files["META-INF/container.xml"]);
  const container = xmlParser.parse(containerXml);
  const opfPath = container.container.rootfiles.rootfile["@_full-path"];
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const opfXml = strFromU8(files[opfPath]);
  const opf = xmlParser.parse(opfXml);
  const pkg = opf.package;

  const titleArr = asArray(pkg.metadata?.["dc:title"]);
  const title = textOf(titleArr[0]) || "Untitled";
  const authorArr = asArray(pkg.metadata?.["dc:creator"]);
  const author = textOf(authorArr[0]) || "Unknown Author";

  const manifestItems = asArray(pkg.manifest.item).reduce((acc, item) => {
    acc[item["@_id"]] = { href: item["@_href"], mediaType: item["@_media-type"] };
    return acc;
  }, {});

  const spineRefs = asArray(pkg.spine.itemref).map((r) => r["@_idref"]);

  const coverMeta = asArray(pkg.metadata?.meta).find((m) => m["@_name"] === "cover");
  const coverItem = coverMeta ? manifestItems[coverMeta["@_content"]] : null;
  const coverPath = coverItem ? opfDir + coverItem.href : null;

  const chapters = spineRefs
    .map((idref) => manifestItems[idref])
    .filter((item) => item && /html|xhtml/.test(item.mediaType))
    .map((item, i) => {
      const path = opfDir + item.href;
      const raw = files[path] ? strFromU8(files[path]) : "";
      const { title: chapTitle, html } = extractChapter(raw, i);
      return { order: i, title: chapTitle, html, wordCount: countWords(html), sourcePath: path };
    });

  const totalWords = chapters.reduce((a, c) => a + c.wordCount, 0);

  return { title, author, coverPath, chapters, totalWords };
}
