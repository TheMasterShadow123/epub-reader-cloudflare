# epub-reader — Cloudflare backend

Worker API backing the reader prototype. Handles epub upload/parsing, storage
(R2), reading progress and stats (D1), and simple password auth.

## What's here

```
wrangler.toml       Worker + bindings config
schema.sql           D1 table definitions
src/index.js          Routes (auth, books, chapters, progress, stats)
src/auth.js           HMAC-signed session tokens (no external JWT lib)
src/epubParser.js     Unzips + parses the epub into chapters (tested — see below)
frontend/api.js       Fetch client the React app will call
```

The epub parser (`src/epubParser.js`) was unit-tested against a synthetic
epub before being copied in here — it correctly pulls title/author/cover,
strips `<script>`/`<style>`/inline event handlers from chapter HTML, and
preserves inline formatting like `<em>`. Real-world epubs vary more than
my test fixture, so if a specific book fails to parse, send me the error
and I'll adjust the OPF/container parsing for that case.

## 1. Prerequisites

```bash
npm install -g wrangler
wrangler login
```

## 2. Create the D1 database and R2 bucket

```bash
cd epub-reader-cloudflare
npm install

wrangler d1 create epub-reader-db
# copy the returned database_id into wrangler.toml

wrangler r2 bucket create epub-reader-files

npm run db:init   # applies schema.sql to the remote D1 database
```

## 3. Set secrets

```bash
wrangler secret put ADMIN_PASSWORD
# enter the password you'll use to log into your library

wrangler secret put SESSION_SECRET
# enter any long random string, e.g. output of: openssl rand -hex 32
```

## 4. Deploy

```bash
npm run deploy
```

This prints your Worker URL, something like
`https://epub-reader.<your-subdomain>.workers.dev`.

## 5. Test it

```bash
# log in
curl -X POST https://epub-reader.<you>.workers.dev/api/login \
  -H "Content-Type: application/json" \
  -d '{"password":"<your password>"}'
# -> {"token":"..."}

# upload a book
curl -X POST https://epub-reader.<you>.workers.dev/api/books \
  -H "Authorization: Bearer <token>" \
  -F "epub=@/path/to/book.epub"

# list your library
curl https://epub-reader.<you>.workers.dev/api/books \
  -H "Authorization: Bearer <token>"
```

## 6. Frontend

`frontend/api.js` is the client the reader app will call — set `API_BASE`
at the top to your deployed Worker URL. Next step is rewiring
`epub-reader.jsx` to:

1. Show a login screen if `isLoggedIn()` is false
2. Replace the hardcoded `ALICE_CHAPTERS` / `DECOR_BOOKS` with `listBooks()`
   / `getBook()` / `getChapter()` calls
3. Call `saveProgress()` on page turns and `reportStats()` on the existing
   5-second tick (the max-dwell WPM filtering already happens client-side —
   this just ships the already-filtered numbers to D1 so they persist)
4. Add an upload button that calls `uploadBook()`

That part touches most of the React file, so I held off doing it in the
same pass as the backend — happy to do it next if the API shape above
looks right to you.

## Notes / things worth knowing

- **Auth** is a single shared password (yours), not per-user accounts —
  matches what you asked for. The session token is a signed, stateless
  30-day token; there's no logout-everywhere/revoke mechanism since there's
  no session table. Fine for personal use; say if you want revocation.
- **Parsing happens on upload**, as you chose — so uploads take a bit
  longer (unzip + parse + write every chapter to R2 + D1 inserts) but every
  read afterward is a single small fetch per chapter.
- **Free tier limits** worth knowing: D1 gives 5GB storage / 25M row reads
  per day; R2 gives 10GB storage with no egress fee; Workers gives 100k
  requests/day. A personal library will not come close to any of these.
- Cover images are served **without** auth (`GET /api/books/:id/cover`) so
  they can be used directly in `<img src>` tags without attaching headers.
  Everything else requires the Bearer token.
