const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

const FB_GRAPH_BASE = "https://graph.facebook.com/v25.0";

// Temporary in-memory storage for a single-user MVP.
const state = {
  userAccessToken: null,
  pageAccessToken: null,
  userId: null
};

function instagramGraphToken() {
  return state.pageAccessToken || state.userAccessToken;
}

function uniqueInstagramTokens() {
  return [...new Set([state.pageAccessToken, state.userAccessToken].filter(Boolean))];
}

async function graphDeleteInstagramMedia(mediaId, accessToken) {
  return axios.delete(`${FB_GRAPH_BASE}/${mediaId}`, {
    params: {
      access_token: accessToken,
      // Matches Meta's curl example for IG Media DELETE (odd but documented alongside DELETE).
      comment_enabled: true
    }
  });
}

/** Deletes one IG Media id using page token first, then user token. */
async function deleteInstagramMediaWithAnyToken(mediaId) {
  const tokens = uniqueInstagramTokens();
  if (!tokens.length) {
    throw new Error("No access token.");
  }

  let lastErr = null;
  for (const t of tokens) {
    try {
      const response = await graphDeleteInstagramMedia(mediaId, t);
      return {
        response,
        usedPageToken: Boolean(state.pageAccessToken) && t === state.pageAccessToken,
        mediaId: String(mediaId)
      };
    } catch (err) {
      const tokenLabel = t === state.pageAccessToken ? "page_token" : "user_token";
      logGraphApiError(`DELETE IG Media ${mediaId} (${tokenLabel})`, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

async function graphDeleteInstagramComment(commentId, accessToken) {
  return axios.delete(`${FB_GRAPH_BASE}/${commentId}`, {
    params: { access_token: accessToken }
  });
}

/** Deletes one IG Comment id using page token first, then user token. */
async function deleteInstagramCommentWithAnyToken(commentId) {
  const tokens = uniqueInstagramTokens();
  if (!tokens.length) {
    throw new Error("No access token.");
  }

  let lastErr = null;
  for (const t of tokens) {
    try {
      const response = await graphDeleteInstagramComment(commentId, t);
      return {
        response,
        usedPageToken: Boolean(state.pageAccessToken) && t === state.pageAccessToken,
        commentId: String(commentId)
      };
    } catch (err) {
      const tokenLabel = t === state.pageAccessToken ? "page_token" : "user_token";
      logGraphApiError(`DELETE IG Comment ${commentId} (${tokenLabel})`, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * If `childMediaId` is a carousel slide, Meta only allows deleting the parent CAROUSEL_ALBUM container.
 * Search recent media for a carousel whose children include this id.
 */
async function findCarouselAlbumParentId(igUserId, childMediaId, apiToken) {
  const maxPages = 25;
  let nextUrl = `${FB_GRAPH_BASE}/${igUserId}/media`;
  let params = {
    fields: "id,media_type,children{id}",
    limit: 50,
    access_token: apiToken
  };

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const resp = await axios.get(nextUrl, params ? { params } : {});
    const items = resp.data?.data || [];

    for (const item of items) {
      if (item.media_type === "CAROUSEL_ALBUM" && Array.isArray(item.children?.data)) {
        const hit = item.children.data.some((c) => String(c.id) === String(childMediaId));
        if (hit) {
          return String(item.id);
        }
      }
    }

    const pagingNext = resp.data?.paging?.next;
    if (!pagingNext) {
      return null;
    }
    nextUrl = pagingNext;
    params = null;
  }

  return null;
}

const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

function normalizePublicBaseUrl(raw) {
  if (!raw) return "";
  let value = String(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/\/$/, "");
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required but missing`);
  }
  return value;
}

function oauthRedirectUriFromEnv() {
  return requiredEnv("REDIRECT_URI").trim();
}

/**
 * Parses redirect URI so you can mirror values in Meta: App domains = host only; Website Site URL = origin/.
 * @returns {{ host: string, origin: string, invalid: boolean }}
 */
function metaOAuthHostHints(redirectUri) {
  try {
    const u = new URL(redirectUri);
    return {
      invalid: false,
      host: u.host,
      origin: `${u.protocol}//${u.host}`
    };
  } catch {
    return { invalid: true, host: "", origin: "" };
  }
}

function base64UrlDecodeToBuffer(input) {
  let b64 = String(input).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) {
    b64 += "=";
  }
  return Buffer.from(b64, "base64");
}

/**
 * Verifies Meta's signed_request (HMAC-SHA256 over the encoded payload segment).
 * @returns {object|null}
 */
function parseFbSignedRequest(signedRequest, appSecret) {
  if (!signedRequest || typeof signedRequest !== "string") {
    return null;
  }
  const parts = signedRequest.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [encodedSig, payloadEncoded] = parts;
  let sig;
  let expectedSig;
  try {
    sig = base64UrlDecodeToBuffer(encodedSig);
    expectedSig = crypto.createHmac("sha256", appSecret).update(payloadEncoded).digest();
  } catch {
    return null;
  }
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(base64UrlDecodeToBuffer(payloadEncoded).toString("utf8"));
  } catch {
    return null;
  }
  if (!data || String(data.algorithm).toUpperCase() !== "HMAC-SHA256") {
    return null;
  }
  return data;
}

/**
 * Logs full Graph error payloads (including error_user_title / error_user_msg / fbtrace_id) to stderr.
 * Use when debugging opaque errors like OAuthException (#1).
 */
function logGraphApiError(context, error) {
  const status = error.response?.status;
  const data = error.response?.data;
  const graphErr = data?.error;
  const summary = graphErr
    ? {
        message: graphErr.message,
        type: graphErr.type,
        code: graphErr.code,
        error_subcode: graphErr.error_subcode,
        error_user_title: graphErr.error_user_title,
        error_user_msg: graphErr.error_user_msg,
        fbtrace_id: graphErr.fbtrace_id,
        is_transient: graphErr.is_transient
      }
    : null;

  // eslint-disable-next-line no-console
  console.error(
    `[Graph API] ${context}`,
    JSON.stringify(
      {
        httpStatus: status,
        axiosMessage: error.message,
        graphError: summary,
        responseBody: data ?? null
      },
      null,
      2
    )
  );
}

/**
 * Before DELETE, Meta often returns only (#1). Logs a read; returns whether at least one token could load the object.
 */
async function logInstagramMediaDeletePreflight(mediaId) {
  const tokens = uniqueInstagramTokens();
  if (!tokens.length) {
    return false;
  }

  const fields = "id,media_type,media_product_type,permalink,timestamp";
  let anyReadable = false;

  for (const t of tokens) {
    const label = t === state.pageAccessToken ? "page_token" : "user_token";
    try {
      const { data } = await axios.get(`${FB_GRAPH_BASE}/${mediaId}`, {
        params: { fields, access_token: t }
      });
      anyReadable = true;
      // eslint-disable-next-line no-console
      console.error(
        `[Graph API] GET IG Media ${mediaId} preflight (${label})`,
        JSON.stringify({ ok: true, media: data }, null, 2)
      );
    } catch (error) {
      logGraphApiError(`GET IG Media ${mediaId} preflight (${label})`, error);
    }
  }

  return anyReadable;
}

/**
 * Loads IG media plus top-level comments (and shallow replies when the API returns them).
 * Falls back to media-only if nested `comments{}` fails (missing scope or field changes).
 */
async function fetchInstagramMediaWithComments(accessToken, igUserId) {
  const baseFields = [
    "id",
    "caption",
    "media_type",
    "media_url",
    "thumbnail_url",
    "permalink",
    "timestamp"
  ];
  /** Try nested replies first; if Graph rejects nested fields we drop replies next. */
  const commentFieldVariants = [
    "comments.limit(40){id,text,timestamp,username,replies.limit(12){id,text,timestamp,username}}",
    "comments.limit(40){id,text,timestamp,username}"
  ];

  let lastCommentAttemptError = null;

  for (const commentNest of commentFieldVariants) {
    const fieldsWithComments = [...baseFields, commentNest].join(",");

    try {
      const { data } = await axios.get(`${FB_GRAPH_BASE}/${igUserId}/media`, {
        params: {
          fields: fieldsWithComments,
          access_token: accessToken,
          limit: 50
        }
      });

      const mediaList = Array.isArray(data?.data) ? data.data : [];
      const items = mediaList.map((item) => {
        const edge = item.comments;
        const commentsPreview = edge && Array.isArray(edge.data) ? edge.data : [];
        const { comments, ...rest } = item;
        return { ...rest, comments_preview: commentsPreview };
      });

      return {
        data: items,
        paging: data.paging,
        commentsIncluded: true,
        ...(commentNest.includes("replies.") ? {} : { commentsRepliesOmitted: true })
      };
    } catch (error) {
      lastCommentAttemptError = error;
      logGraphApiError(
        `GET IG user media with comments (variant skipped: ${commentNest.slice(0, 40)}...)`,
        error
      );
    }
  }

  const { data } = await axios.get(`${FB_GRAPH_BASE}/${igUserId}/media`, {
    params: {
      fields: baseFields.join(","),
      access_token: accessToken,
      limit: 50
    }
  });

  const mediaList = Array.isArray(data?.data) ? data.data : [];
  const items = mediaList.map((row) => ({ ...row, comments_preview: [] }));

  return {
    data: items,
    paging: data.paging,
    commentsIncluded: false,
    commentsErrorSummary:
      lastCommentAttemptError?.response?.data?.error || { message: lastCommentAttemptError?.message }
  };
}

function buildMultipartPayload({ boundary, fields, fileFieldName, fileName, mimeType, buffer }) {
  const fieldParts = Object.entries(fields)
    .map(
      ([key, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    )
    .join("");
  const fileHeader =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;

  return Buffer.concat([
    Buffer.from(fieldParts + fileHeader, "utf8"),
    buffer,
    Buffer.from(fileFooter, "utf8")
  ]);
}

async function uploadToCatbox(buffer, fileName, mimeType) {
  const boundary = `----cursorBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
  const payload = buildMultipartPayload({
    boundary,
    fields: { reqtype: "fileupload" },
    fileFieldName: "fileToUpload",
    fileName,
    mimeType,
    buffer
  });

  const response = await axios.post("https://catbox.moe/user/api.php", payload, {
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": payload.length
    },
    maxBodyLength: Infinity,
    timeout: 30000
  });

  const body = String(response.data || "").trim();
  if (!/^https?:\/\//.test(body)) {
    throw new Error(body || "Catbox upload failed.");
  }

  return body;
}

async function uploadTo0x0(buffer, fileName, mimeType) {
  const boundary = `----cursorBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
  const payload = buildMultipartPayload({
    boundary,
    fields: {},
    fileFieldName: "file",
    fileName,
    mimeType,
    buffer
  });

  const response = await axios.post("https://0x0.st", payload, {
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": payload.length
    },
    maxBodyLength: Infinity,
    timeout: 30000
  });

  const body = String(response.data || "").trim();
  if (!/^https?:\/\//.test(body)) {
    throw new Error(body || "0x0.st upload failed.");
  }

  return body;
}

async function uploadImageToPublicHost(buffer, fileName, mimeType) {
  const errors = [];

  try {
    return await uploadToCatbox(buffer, fileName, mimeType);
  } catch (error) {
    errors.push(`catbox: ${error.response?.data || error.message}`);
  }

  try {
    return await uploadTo0x0(buffer, fileName, mimeType);
  } catch (error) {
    errors.push(`0x0.st: ${error.response?.data || error.message}`);
  }

  throw new Error(`Public image upload failed on all providers. ${errors.join(" | ")}`);
}

/**
 * Instagram Content Publishing expects a JPEG at image_url (see Meta IG User Media docs).
 * Normalize browser/WebP/PNG/HEIF uploads to JPEG and cap dimensions within API guidance.
 */
async function bufferToInstagramJpeg(buffer) {
  try {
    return await sharp(buffer)
      .rotate()
      .resize({
        width: 1440,
        height: 1440,
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({
        quality: 88,
        mozjpeg: true
      })
      .toBuffer();
  } catch (err) {
    const enriched = new Error(
      `${err.message || "Image decode failed"}. Export as JPEG from your editor or Photos if this persists (HEIC can fail on some servers).`
    );
    enriched.cause = err;
    throw enriched;
  }
}

async function probeUrlReachability(url) {
  try {
    const parsed = new URL(String(url));
    const host = parsed.hostname.toLowerCase();
    const headers = {
      // Avoid some CDNs/WAFs rejecting "empty" user agents.
      "User-Agent": "InstagramConnectDashboard/1.0 (+https://localhost)"
    };

    // ngrok free tier sometimes serves an interstitial HTML page unless this header is present.
    if (host.includes("ngrok")) {
      headers["ngrok-skip-browser-warning"] = "true";
    }

    const response = await axios.get(url, {
      timeout: 15000,
      responseType: "stream",
      maxRedirects: 10,
      headers,
      validateStatus: () => true
    });
    if (response.data && typeof response.data.destroy === "function") {
      response.data.destroy();
    }
    const ok = response.status >= 200 && response.status < 400;
    return { ok, status: response.status };
  } catch (error) {
    return { ok: false, status: null, error: error.message };
  }
}

/**
 * Mimics Meta/Instagram fetching image_url: no ngrok bypass header — free ngrok often returns HTML instead of JPEG here.
 */
async function probeUrlAsMetaImageFetcher(url) {
  try {
    const parsed = new URL(String(url));
    const headers = {
      "User-Agent":
        "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
    };

    const response = await axios.get(url, {
      timeout: 15000,
      responseType: "stream",
      maxRedirects: 5,
      headers,
      validateStatus: () => true
    });

    const contentTypeRaw = response.headers["content-type"] || "";
    const primaryType = contentTypeRaw.split(";")[0].trim().toLowerCase();
    const statusOk = response.status >= 200 && response.status < 400;
    const looksLikeImage = /^image\/(jpeg|jpg|pjpeg)$/i.test(primaryType);

    if (response.data && typeof response.data.destroy === "function") {
      response.data.destroy();
    }

    return {
      ok: statusOk && looksLikeImage,
      status: response.status,
      contentType: contentTypeRaw
    };
  } catch (error) {
    return { ok: false, status: null, contentType: "", error: error.message };
  }
}

app.get("/api/config", (_req, res) => {
  const publicBaseUrl = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL);
  res.json({
    isConnected: Boolean(instagramGraphToken()),
    canDeleteViaApi: true,
    publicBaseUrlConfigured: Boolean(publicBaseUrl),
    publicBaseUrlLooksLikeExample: publicBaseUrl.includes("abc123.ngrok-free.app")
  });
});

app.get("/api/auth/url", (_req, res) => {
  try {
    const appId = requiredEnv("INSTAGRAM_APP_ID");
    const redirectUri = oauthRedirectUriFromEnv();
    const scopes = [
      "instagram_basic",
      "instagram_content_publish",
      "instagram_manage_comments",
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "business_management"
    ];

    const authUrl =
      "https://www.facebook.com/v25.0/dialog/oauth" +
      `?client_id=${encodeURIComponent(appId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(scopes.join(","))}` +
      "&response_type=code";

    const hints = metaOAuthHostHints(redirectUri);
    res.json({
      authUrl,
      redirectUri,
      metaCheck: hints.invalid
        ? {
            redirectUriInvalidUrl: true
          }
        : {
            appDomainsPlainHost: hints.host,
            websiteSiteUrlSuggested: `${hints.origin}/`,
            oauthRedirectUriForMetaLoginSettings: redirectUri
          }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Meta Dashboard → User data deletion → Data deletion callback URL (POST signed_request).
 * https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 */
app.post("/api/meta/data-deletion", (req, res) => {
  const signedRequest = req.body?.signed_request;
  if (!signedRequest) {
    return res.status(400).json({ error: "Missing signed_request." });
  }

  let appSecret;
  try {
    appSecret = requiredEnv("INSTAGRAM_APP_SECRET");
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const payload = parseFbSignedRequest(signedRequest, appSecret);
  if (!payload) {
    return res.status(400).json({ error: "Invalid signed_request." });
  }

  const fbUserId = payload.user_id != null ? String(payload.user_id) : null;
  if (fbUserId && state.userId && String(state.userId) === fbUserId) {
    state.userAccessToken = null;
    state.pageAccessToken = null;
    state.userId = null;
  }

  const confirmationCode = crypto.randomBytes(16).toString("hex");
  const host = req.get("host");
  const protoChunk = req.get("x-forwarded-proto") || "";
  const proto =
    (protoChunk.split(",")[0] && protoChunk.split(",")[0].trim()) || req.protocol || "https";
  const baseForStatus =
    normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL) || (host ? `${proto}://${host}` : "");

  const statusUrl = baseForStatus
    ? `${baseForStatus}/data-deletion-status.html?code=${encodeURIComponent(confirmationCode)}`
    : "";

  if (!statusUrl) {
    return res.status(500).json({
      error:
        "Set PUBLIC_BASE_URL to your HTTPS app URL so Meta receives a deletion status link, or confirm Host is sent on POST."
    });
  }

  return res.json({
    url: statusUrl,
    confirmation_code: confirmationCode
  });
});

app.get("/api/auth/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("Missing code query parameter.");
  }

  try {
    const appId = requiredEnv("INSTAGRAM_APP_ID");
    const appSecret = requiredEnv("INSTAGRAM_APP_SECRET");
    const redirectUri = oauthRedirectUriFromEnv();

    const tokenResponse = await axios.get(`${FB_GRAPH_BASE}/oauth/access_token`, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code
      }
    });

    const shortLivedToken = tokenResponse.data.access_token;
    const longLivedResponse = await axios.get(`${FB_GRAPH_BASE}/oauth/access_token`, {
      params: {
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortLivedToken
      }
    });

    const accessToken = longLivedResponse.data.access_token || shortLivedToken;
    const pagesResponse = await axios.get(`${FB_GRAPH_BASE}/me/accounts`, {
      params: {
        fields: "id,name,access_token,instagram_business_account",
        access_token: accessToken
      }
    });

    const pages = pagesResponse.data?.data || [];
    if (!pages.length) {
      throw new Error("No Facebook pages found for this user. Connect a page that is linked to an Instagram Business/Creator account.");
    }

    let instagramBusinessId = null;
    let linkedPageAccessToken = null;
    for (const page of pages) {
      const candidateId = page.instagram_business_account?.id;
      if (candidateId) {
        instagramBusinessId = candidateId;
        linkedPageAccessToken = page.access_token || null;
        break;
      }
    }

    if (!instagramBusinessId) {
      throw new Error(
        "No Instagram Business/Creator account is linked to your Facebook pages. Link Instagram in Meta Business settings and try again."
      );
    }

    const meResponse = await axios.get(`${FB_GRAPH_BASE}/${instagramBusinessId}`, {
      params: {
        fields: "id,username",
        access_token: accessToken
      }
    });

    state.userAccessToken = accessToken;
    state.pageAccessToken = linkedPageAccessToken;
    state.userId = meResponse.data.id;

    return res.redirect("/?connected=1");
  } catch (error) {
    const details = error.response?.data || error.message;
    return res.status(500).json({
      error: "Instagram auth failed",
      details
    });
  }
});

app.get("/api/posts", async (_req, res) => {
  const token = instagramGraphToken();
  if (!token) {
    return res.status(401).json({ error: "Not connected to Instagram yet." });
  }

  try {
    const payload = await fetchInstagramMediaWithComments(token, state.userId);
    return res.json(payload);
  } catch (error) {
    const details = error.response?.data || error.message;
    return res.status(500).json({ error: "Failed to fetch posts", details });
  }
});

app.post("/api/posts/publish", async (req, res) => {
  const token = instagramGraphToken();
  if (!token || !state.userId) {
    return res.status(401).json({ error: "Not connected to Instagram yet." });
  }

  const { imageUrl, caption } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ error: "imageUrl is required." });
  }

  try {
    const createMedia = await axios.post(
      `${FB_GRAPH_BASE}/${state.userId}/media`,
      null,
      {
        params: {
          image_url: imageUrl,
          caption: caption || "",
          access_token: token
        }
      }
    );

    const creationId = createMedia.data.id;

    const publishMedia = await axios.post(
      `${FB_GRAPH_BASE}/${state.userId}/media_publish`,
      null,
      {
        params: {
          creation_id: creationId,
          access_token: token
        }
      }
    );

    return res.json({
      message: "Post published (or queued by Instagram).",
      creationId,
      publishResult: publishMedia.data
    });
  } catch (error) {
    const details = error.response?.data || error.message;
    const fb = details?.error;
    const fbMsg = [fb?.error_user_title, fb?.error_user_msg].filter(Boolean).join(": ");
    return res.status(500).json({
      error: "Failed to publish post",
      details,
      error_user_msg: fb?.error_user_msg || null,
      hint:
        fbMsg && /unsupported|format|unknown|jpeg|jpg/i.test(fbMsg)
          ? "Ensure image_url serves a plain JPEG binary (HTTPS, no login page). This app converts uploads to .jpg automatically after npm install sharp + redeploy."
          : fb?.error_subcode === 2207052 || /media could not be fetched|retrieve media/i.test(String(fb?.message || ""))
            ? "Instagram could not fetch your image URL — confirm it opens directly in an incognito window and serves image/jpeg."
            : null
    });
  }
});

app.post("/api/uploads", async (req, res) => {
  const { fileName, mimeType, dataUrl } = req.body || {};

  if (!fileName || !mimeType || !dataUrl) {
    return res.status(400).json({ error: "fileName, mimeType, and dataUrl are required." });
  }

  if (!mimeType.startsWith("image/")) {
    return res.status(400).json({ error: "Only image uploads are supported." });
  }

  const dataPrefix = `data:${mimeType};base64,`;
  if (!dataUrl.startsWith(dataPrefix)) {
    return res.status(400).json({ error: "Invalid data URL payload." });
  }

  try {
    const base64Payload = dataUrl.slice(dataPrefix.length);
    const buffer = Buffer.from(base64Payload, "base64");
    let jpegBuffer;
    try {
      jpegBuffer = await bufferToInstagramJpeg(buffer);
    } catch (convertErr) {
      return res.status(400).json({
        error: "The image format is not supported or could not be processed.",
        hint: "Instagram needs JPEG bytes at a public URL — we convert uploads for you. Try a JPG/PNG/WebP screenshot; HEIC/iPhone raw files may fail until exported as JPG.",
        details: convertErr.message
      });
    }

    const safeFileName = `upload-${Date.now()}.jpg`;
    const localFilePath = path.join(uploadDir, safeFileName);
    fs.writeFileSync(localFilePath, jpegBuffer);
    const outMime = "image/jpeg";

    const publicBaseUrl = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL);
    if (publicBaseUrl) {
      if (publicBaseUrl.includes("abc123.ngrok-free.app")) {
        return res.status(400).json({
          error: "PUBLIC_BASE_URL looks like the example placeholder.",
          hint: "Replace PUBLIC_BASE_URL with the exact HTTPS URL shown by ngrok/cloudflared (Forwarding line), then restart the server."
        });
      }

      if (!/^https:\/\//i.test(publicBaseUrl)) {
        return res.status(400).json({
          error: "PUBLIC_BASE_URL must start with https://",
          hint: "Use the HTTPS forwarding URL from ngrok/cloudflared, without a trailing slash."
        });
      }

      return res.json({ imageUrl: `${publicBaseUrl}/uploads/${safeFileName}` });
    }

    const imageUrl = await uploadImageToPublicHost(jpegBuffer, safeFileName, outMime);

    return res.json({ imageUrl });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to upload image",
      details:
        error.response?.data ||
        `${error.message}. Configure PUBLIC_BASE_URL (for example an ngrok/cloudflared URL) to publish from your own hosted upload path.`
    });
  }
});

app.get("/api/health/upload", async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: "url query parameter is required." });
  }

  const publicBaseUrl = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL);
  if (publicBaseUrl && publicBaseUrl.includes("abc123.ngrok-free.app")) {
    return res.status(400).json({
      ok: false,
      error: "PUBLIC_BASE_URL is still set to the example placeholder.",
      hint: "Update PUBLIC_BASE_URL to your real ngrok/cloudflared HTTPS URL and restart the server."
    });
  }

  const imageUrl = String(url);
  const uploadsMatch = imageUrl.match(/\/uploads\/([^/?#]+)$/i);
  if (uploadsMatch?.[1]) {
    const localPath = path.join(uploadDir, uploadsMatch[1]);
    if (!fs.existsSync(localPath)) {
      return res.status(404).json({
        ok: false,
        error: "Uploaded file is missing on the server disk.",
        hint: "Try uploading again. If this repeats, your server restarted and lost in-memory state is unrelated, but uploads should still exist under public/uploads."
      });
    }
  }

  const probe = await probeUrlReachability(imageUrl);
  if (!probe.ok) {
    return res.status(503).json({
      ok: false,
      error: "Uploaded image URL is not publicly reachable.",
      httpStatus: probe.status,
      networkError: probe.error || null,
      hint:
        "Open the imageUrl in a normal browser tab. If it does not load, your PUBLIC_BASE_URL is wrong or your tunnel is not running. Also ensure PUBLIC_BASE_URL has no quotes and no trailing slash."
    });
  }

  let metaProbe = null;
  try {
    const hostLower = new URL(imageUrl).hostname.toLowerCase();
    if (hostLower.includes("ngrok")) {
      metaProbe = await probeUrlAsMetaImageFetcher(imageUrl);
      if (!metaProbe.ok) {
        return res.status(503).json({
          ok: false,
          error:
            "This URL responds for the dashboard probe but probably not like Instagram's crawler — common with free ngrok (HTML intercept / warning page).",
          instagramStyleProbeHttpStatus: metaProbe.status ?? null,
          instagramStyleProbeContentType: metaProbe.contentType || null,
          networkError: metaProbe.error || null,
          hint:
            "Set PUBLIC_BASE_URL to your Railway (or production) HTTPS host so image_url matches what Meta crawls. The app uses ngrok-skip-browser-warning for its own health check only; Meta does not send that header."
        });
      }
    }
  } catch {
    /* invalid URL handled earlier */
  }

  return res.json({ ok: true, url });
});

app.delete("/api/comments/:id", async (req, res) => {
  const token = instagramGraphToken();
  if (!token || !state.userId) {
    return res.status(401).json({ error: "Not connected to Instagram yet." });
  }

  const { id } = req.params;
  if (!id || !/^\d+$/.test(String(id))) {
    return res.status(400).json({ error: "Invalid comment id." });
  }

  const commentId = String(id);

  try {
    const { response, usedPageToken } = await deleteInstagramCommentWithAnyToken(commentId);
    return res.json({
      message: "Comment deleted.",
      graph: response.data,
      usedPageToken,
      deletedCommentId: commentId
    });
  } catch (error) {
    logGraphApiError(`DELETE /api/comments/${commentId}`, error);
    const details = error.response?.data || error.message;
    const fbErr = details?.error;
    return res.status(502).json({
      error: "Failed to delete comment on Instagram.",
      details,
      code: fbErr?.code,
      error_subcode: fbErr?.error_subcode,
      error_user_title: fbErr?.error_user_title,
      error_user_msg: fbErr?.error_user_msg,
      fbtrace_id: fbErr?.fbtrace_id,
      hint:
        "Requires instagram_manage_comments and a token that can moderate this media. Reconnect after enabling the permission in your Meta app. Some comment types or placements may be rejected by Meta.",
      docs: "https://developers.facebook.com/docs/instagram-platform/reference/instagram-comment"
    });
  }
});

app.delete("/api/posts/:id", async (req, res) => {
  const token = instagramGraphToken();
  if (!token || !state.userId) {
    return res.status(401).json({ error: "Not connected to Instagram yet." });
  }

  const { id } = req.params;
  if (!id || !/^\d+$/.test(String(id))) {
    return res.status(400).json({ error: "Invalid media id." });
  }

  const requestedId = String(id);

  const igMediaReadable = await logInstagramMediaDeletePreflight(requestedId);

  try {
    try {
      const { response, usedPageToken, mediaId } = await deleteInstagramMediaWithAnyToken(requestedId);
      return res.json({
        message: "Media deleted.",
        graph: response.data,
        usedPageToken,
        deletedMediaId: mediaId,
        requestedMediaId: requestedId,
        strategy: "direct"
      });
    } catch (firstErr) {
      const parentId = await findCarouselAlbumParentId(state.userId, requestedId, token);
      if (parentId && parentId !== requestedId) {
        const { response, usedPageToken, mediaId } = await deleteInstagramMediaWithAnyToken(parentId);
        return res.json({
          message:
            "Carousel post deleted. Instagram does not allow deleting one slide only; the whole carousel album was removed.",
          graph: response.data,
          usedPageToken,
          deletedMediaId: mediaId,
          requestedMediaId: requestedId,
          strategy: "carousel_parent"
        });
      }
      throw firstErr;
    }
  } catch (error) {
    logGraphApiError(`DELETE /api/posts/${requestedId} (after direct + carousel-parent attempts)`, error);

    const details = error.response?.data || error.message;
    const fbErr = details?.error;
    const code = fbErr?.code;
    const sub = fbErr?.error_subcode;

    let hint =
      "No app can delete “everything” on Instagram. The official API only removes certain IG Media on the connected professional account (Meta may still block ads/boosted items, some placement types, or media outside your permission).";

    if (!state.pageAccessToken) {
      hint += " Reconnect Instagram so the server can store a Page access token from /me/accounts.";
    }

    if (code === 1) {
      hint +=
        " When (#1) has no error_user_msg/error_subcode, Meta is not exposing the reason; use fbtrace_id with Meta tooling or Support. Above this response, server logs include GET preflight vs DELETE.";
    }

    let interpretation = null;
    if (igMediaReadable && code === 1) {
      interpretation =
        "Your logs show GET /{ig-media-id} succeeded (IMAGE, FEED) for both page and user tokens, but DELETE still returns (#1). That means your app and tokens can read the media; Meta is still refusing the delete call. Next: try the same DELETE in Graph API Explorer with the same token; if it also fails, treat this as a Meta platform or app-mode limitation and open a support case with fbtrace_id, or delete the post in the Instagram app.";
    }

    return res.status(502).json({
      error: "Failed to delete post on Instagram.",
      details,
      code,
      error_subcode: sub,
      interpretation,
      igMediaReadable,
      error_user_title: fbErr?.error_user_title,
      error_user_msg: fbErr?.error_user_msg,
      fbtrace_id: fbErr?.fbtrace_id,
      graphErrorSummary: fbErr
        ? {
            message: fbErr.message,
            type: fbErr.type,
            code: fbErr.code,
            error_subcode: fbErr.error_subcode,
            error_user_title: fbErr.error_user_title,
            error_user_msg: fbErr.error_user_msg,
            fbtrace_id: fbErr.fbtrace_id
          }
        : null,
      hint,
      docs: "https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/",
      apiNote:
        "Automating deletion beyond what Meta documents is not supported; use the Instagram app for anything the API rejects.",
      serverLogNote: "Full Graph responseBody was printed to the Node server console (stderr)."
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${PORT}`);
  const publicBaseUrl = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL);
  if (publicBaseUrl) {
    // eslint-disable-next-line no-console
    console.log(`PUBLIC_BASE_URL configured: ${publicBaseUrl}`);
    if (publicBaseUrl.includes("abc123.ngrok-free.app")) {
      // eslint-disable-next-line no-console
      console.warn(
        "PUBLIC_BASE_URL still looks like the example placeholder. Replace it with your real tunnel URL or uploads will not be reachable."
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "PUBLIC_BASE_URL is not set. Instagram publishing will try third-party image hosts, which may be blocked or unavailable."
    );
  }
});
