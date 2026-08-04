const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Create a signed, self-contained session token. No server-side session store needed. */
export async function createToken(payload, secret) {
  const key = await hmacKey(secret);
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const sig = base64url(new Uint8Array(sigBuf));
  return `${body}.${sig}`;
}

/** Returns the decoded payload if the token is validly signed and not expired, else null. */
export async function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, base64urlDecode(sig), encoder.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(base64urlDecode(body)));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Reads the Bearer token off the request and verifies it. Returns payload or null. */
export async function getSession(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  return verifyToken(token, env.SESSION_SECRET);
}
