import { Router } from "itty-router";
import { unzipSync } from "fflate";
import { createToken, getSession } from "./auth.js";
import { parseEpub } from "./epubParser.js";

const router = Router();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...cors },
    ...init,
  });

async function requireAuth(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Unauthorized" }, { status: 401 });
  return null; // null means "continue"
}

router.options("*", () => new Response(null, { headers: cors }));

/* ---------------------------- auth ---------------------------- */

router.post("/api/login", async (request, env) => {
  const { password } = await request.json().catch(() => ({}));
  if (!password || password !== env.ADMIN_PASSWORD) {
    return json({ error: "Invalid password" }, { status: 401 });
  }
  const token = await createToken(
    { sub: "admin", exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }, // 30 days
    env.SESSION_SECRET
  );
  return json({ token });
});

/* ---------------------------- books ---------------------------- */

router.get("/api/books", async (request, env) => {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.title, b.author, b.cover_key, b.total_words, b.created_at,
            p.chapter_idx, p.page_in_chapter,
            s.total_seconds, s.wpm_valid_words, s.wpm_valid_ms
     FROM books b
     LEFT JOIN progress p ON p.book_id = b.id
     LEFT JOIN reading_stats s ON s.book_id = b.id
     ORDER BY b.created_at DESC`
  ).all();
  return json({ books: results });
});

router.get("/api/books/:id", async (request, env) => {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const { id } = request.params;
  const book = await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(id).first();
  if (!book) return json({ error: "Not found" }, { status: 404 });
  const { results: chapters } = await env.DB.prepare(
    "SELECT idx, title, word_count FROM chapters WHERE book_id = ? ORDER BY idx"
  ).bind(id).all();
  const progress = await env.DB.prepare("SELECT * FROM progress WHERE book_id = ?").bind(id).first();
  const stats = await env.DB.prepare("SELECT * FROM reading_stats WHERE book_id = ?").bind(id).first();
  return json({ book, chapters, progress, stats });
});

router.get("/api/books/:id/chapters/:idx", async (request, env) => {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const { id, idx } = request.params;
  const row = await env.DB.prepare(
    "SELECT r2_key FROM chapters WHERE book_id = ? AND idx = ?"
  ).bind(id, idx).first();
  if (!row) return json({ error: "Not found" }, { status: 404 });
  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) return json({ error: "Not found" }, { status: 404 });
  return json({ html: await obj.text() });
});

// covers are non-sensitive; served without auth so they load as plain <img> tags
router.get("/api/books/:id/cover", async (request, env) => {
  const { id } = request.params;
  const book = await env.DB.prepare("SELECT cover_key FROM books WHERE id = ?").bind(id).first();
  if (!book?.cover_key) return new Response(null, { status: 404 });
  const obj = await env.BUCKET.get(book.cover_key);
  if (!obj) return new Response(null, { status: 404 });
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", ...cors },
  });
});

router.post("/api/books", async (request, env) => {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const form = await request.formData().catch(() => null);
  const file = form?.get("epub");
  if (!file) return json({ error: "No file provided (form field must be named 'epub')" }, { status: 400 });

  const buffer = await file.arrayBuffer();
  let parsed;
  try {
    parsed = parseEpub(buffer);
  } catch (e) {
    return json({ error: "Failed to parse epub: " + e.message }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const epubKey = `epubs/${id}.epub`;
  await env.BUCKET.put(epubKey, buffer);

  const files = unzipSync(new Uint8Array(buffer));

  let coverKey = null;
  if (parsed.coverPath) {
    const coverBytes = files[parsed.coverPath];
    if (coverBytes) {
      coverKey = `covers/${id}.${parsed.coverExt}`;
      await env.BUCKET.put(coverKey, coverBytes, {
        httpMetadata: { contentType: parsed.coverMediaType || "image/jpeg" },
      });
    }
  }

  // Upload every in-chapter image the parser actually found references to.
  for (const asset of parsed.assets) {
    const bytes = files[asset.path];
    if (!bytes) continue;
    const assetKey = `assets/${id}/${encodeURIComponent(asset.path)}`;
    await env.BUCKET.put(assetKey, bytes, { httpMetadata: { contentType: asset.mediaType } });
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO books (id, title, author, cover_key, epub_key, total_words, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, parsed.title, parsed.author, coverKey, epubKey, parsed.totalWords, now),
    env.DB.prepare(
      "INSERT INTO progress (book_id, chapter_idx, page_in_chapter, updated_at) VALUES (?, 0, 0, ?)"
    ).bind(id, now),
    env.DB.prepare(
      "INSERT INTO reading_stats (book_id, total_seconds, wpm_valid_words, wpm_valid_ms, updated_at) VALUES (?, 0, 0, 0, ?)"
    ).bind(id, now),
  ]);

  const assetUrlPrefix = `/api/books/${id}/asset/`;
  for (const ch of parsed.chapters) {
    const chapterKey = `chapters/${id}/${ch.order}.html`;
    const html = ch.html.replaceAll("__ASSET__/", assetUrlPrefix);
    await env.BUCKET.put(chapterKey, html);
    await env.DB.prepare(
      "INSERT INTO chapters (book_id, idx, title, word_count, r2_key) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, ch.order, ch.title, ch.wordCount, chapterKey).run();
  }

  return json({ id, title: parsed.title, author: parsed.author, chapterCount: parsed.chapters.length });
});

// In-chapter images (not the cover) — unauthenticated like the cover route so
// they load as plain <img> tags. The trailing path segment is the original
// zip-relative path, percent-encoded as a single unit by the parser, so it's
// used as-is to rebuild the same key the upload step wrote to.
router.get("/api/books/:id/asset/*", async (request, env) => {
  const url = new URL(request.url);
  const marker = "/asset/";
  const encoded = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  let assetPath;
  try {
    assetPath = decodeURIComponent(encoded);
  } catch {
    return new Response(null, { status: 400 });
  }
  const key = `assets/${request.params.id}/${encodeURIComponent(assetPath)}`;
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response(null, { status: 404 });
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream", ...cors },
  });
});

router.delete("/api/books/:id", async (request, env) => {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const { id } = request.params;

  const book = await env.DB.prepare("SELECT epub_key, cover_key FROM books WHERE id = ?").bind(id).first();
  if (!book) return json({ error: "Not found" }, { status: 404 });
  const { results: chapters } = await env.DB.prepare("SELECT r2_key FROM chapters WHERE book_id = ?").bind(id).all();

  const r2Keys = [book.epub_key, book.cover_key, ...chapters.map((c) => c.r2_key)].filter(Boolean);
  if (r2Keys.length) await env.BUCKET.delete(r2Keys);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM chapters WHERE book_id = ?").bind(id),
    env.DB.prepare("DELETE FROM progress WHERE book_id = ?").bind(id),
    env.DB.prepare("DELETE FROM reading_stats WHERE book_id = ?").bind(id),
    env.DB.prepare("DELETE FROM books WHERE id = ?").bind(id),
  ]);

  return json({ ok: true });
});

/* ---------------------- progress + stats ---------------------- */

router.post("/api/books/:id/progress", async (request, env) => {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const { id } = request.params;
  const { chapterIdx, pageInChapter } = await request.json();
  await env.DB.prepare(
    `INSERT INTO progress (book_id, chapter_idx, page_in_chapter, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET
       chapter_idx = excluded.chapter_idx,
       page_in_chapter = excluded.page_in_chapter,
       updated_at = excluded.updated_at`
  ).bind(id, chapterIdx, pageInChapter, Date.now()).run();
  return json({ ok: true });
});

// Client already applies the 2-minute max-dwell-per-page filter before
// sending these deltas — this endpoint just accumulates the running totals.
router.post("/api/books/:id/stats", async (request, env) => {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const { id } = request.params;
  const { addSeconds = 0, addWpmWords = 0, addWpmMs = 0 } = await request.json();
  await env.DB.prepare(
    `UPDATE reading_stats
     SET total_seconds = total_seconds + ?,
         wpm_valid_words = wpm_valid_words + ?,
         wpm_valid_ms = wpm_valid_ms + ?,
         updated_at = ?
     WHERE book_id = ?`
  ).bind(addSeconds, addWpmWords, addWpmMs, Date.now(), id).run();
  return json({ ok: true });
});

router.all("*", () => json({ error: "Not found" }, { status: 404 }));

export default {
  fetch: async (request, env, ctx) => {
    try {
      return await router.handle(request, env, ctx);
    } catch (e) {
      // Without this catch, an uncaught error bypasses json()'s CORS headers
      // entirely, and the browser reports a confusing "CORS blocked" error
      // instead of the real 500 and message.
      return json({ error: e.message || "Internal error" }, { status: 500 });
    }
  },
};
