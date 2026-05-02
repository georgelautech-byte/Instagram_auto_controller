const connectBtn = document.getElementById("connectBtn");
const loadBtn = document.getElementById("loadBtn");
const postsContainer = document.getElementById("posts");
const statusEl = document.getElementById("status");
const publishForm = document.getElementById("publishForm");
const imageFileInput = document.getElementById("imageFile");
const captionInput = document.getElementById("caption");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function escapeHtml(value) {
  if (value == null || value === "") return "";
  const div = document.createElement("div");
  div.textContent = String(value);
  return div.innerHTML;
}

function formatCommentTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function deleteCommentControlHtml(commentId, enabled) {
  if (!enabled || commentId == null || String(commentId).trim() === "") return "";
  const idAttr = escapeHtml(String(commentId));
  return `<button type="button" class="delete-comment-btn" data-comment-id="${idAttr}" title="Remove this comment on Instagram">Delete</button>`;
}

/** @param {unknown[]} replies */
function buildRepliesHtml(replies, canModerateComments) {
  if (!replies?.length) return "";
  const items = replies
    .map((r) => {
      const name = escapeHtml(r.username || "Instagram user");
      const text = escapeHtml(r.text || "");
      const when = formatCommentTime(r.timestamp);
      const meta = when ? `<time class="comment-time" datetime="${escapeHtml(String(r.timestamp))}">${escapeHtml(when)}</time>` : "";
      const del = deleteCommentControlHtml(r.id, canModerateComments);
      return `<li class="comment comment-reply">
        <div class="comment-head">
          <span class="comment-author">@${name}</span>
          ${meta}
          ${del}
        </div>
        <div class="comment-text">${text}</div>
      </li>`;
    })
    .join("");
  return `<ul class="comment-replies">${items}</ul>`;
}

/** @param {unknown[]} preview */
function buildCommentsPreviewHtml(preview, canModerateComments) {
  if (!preview?.length) {
    return '<p class="no-comments">No comments yet.</p>';
  }

  const items = preview
    .map((c) => {
      const name = escapeHtml(c.username || "Instagram user");
      const text = escapeHtml(c.text || "");
      const when = formatCommentTime(c.timestamp);
      const meta = when ? `<time class="comment-time" datetime="${escapeHtml(String(c.timestamp))}">${escapeHtml(when)}</time>` : "";
      const del = deleteCommentControlHtml(c.id, canModerateComments);
      const repliesHtml = buildRepliesHtml(c.replies?.data, canModerateComments);
      return `<li class="comment">
        <div class="comment-head">
          <span class="comment-author">@${name}</span>
          ${meta}
          ${del}
        </div>
        <div class="comment-text">${text}</div>
        ${repliesHtml}
      </li>`;
    })
    .join("");

  return `<ul class="post-comments">${items}</ul>`;
}

function extractErrorMessage(payload, fallbackMessage) {
  if (!payload) return fallbackMessage;
  const graphMessage =
    payload.details?.error?.message ||
    payload.graphErrorSummary?.message ||
    payload.error_user_msg;
  const detailMessage = typeof payload.details === "string" ? payload.details : null;
  const base = graphMessage || detailMessage || payload.error || fallbackMessage;
  let out = base;
  if (payload.interpretation) {
    out += ` ${payload.interpretation}`;
  }
  if (payload.hint) {
    out += ` (${payload.hint})`;
  }
  if (payload.docs) {
    out += ` See: ${payload.docs}`;
  }
  if (payload.apiNote) {
    out += ` ${payload.apiNote}`;
  }
  return out;
}

function renderPosts(items, options = {}) {
  const { commentsIncluded = true, commentsErrorSummary } = options;

  postsContainer.innerHTML = "";
  if (!items?.length) {
    postsContainer.innerHTML = "<p>No posts found.</p>";
    return;
  }

  if (!commentsIncluded) {
    const msg = commentsErrorSummary?.error_user_msg || commentsErrorSummary?.message || "";
    const warn = document.createElement("div");
    warn.className = "comments-banner";
    warn.innerHTML = `<strong>Comments not loaded.</strong> Re-connect Instagram after your Meta app grants <code>instagram_manage_comments</code>. ${escapeHtml(msg)}`;
    postsContainer.appendChild(warn);
  }

  items.forEach((post) => {
    const postEl = document.createElement("article");
    postEl.className = "post";
    const image = escapeHtml(post.media_url || post.thumbnail_url || "");
    const captionText = escapeHtml(post.caption || "(No caption)");
    const captionPlain = post.caption || "Instagram post";
    const permalink = escapeHtml(post.permalink || "");
    const commentsBlock = buildCommentsPreviewHtml(post.comments_preview, Boolean(commentsIncluded));

    postEl.innerHTML = `
      <img src="${image}" alt="${escapeHtml(captionPlain)}" />
      <div class="post-body">
        <p>${captionText}</p>
        <a href="${permalink}" target="_blank" rel="noreferrer">Open on Instagram</a>
        <button data-id="${escapeHtml(String(post.id))}" class="delete-btn" type="button">Delete on Instagram</button>
        <div class="post-comments-section">
          <h3 class="comments-heading">Comments</h3>
          ${commentsBlock}
        </div>
      </div>
    `;
    postsContainer.appendChild(postEl);
  });

  postsContainer.querySelectorAll(".delete-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-id");
      if (!id || !confirm("Delete this post on Instagram? This cannot be undone.")) return;
      setStatus("Deleting post...");
      try {
        const response = await fetch(`/api/posts/${id}`, { method: "DELETE" });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(extractErrorMessage(data, "Delete failed."));
        }
        setStatus(data.message || "Post deleted.");
        await loadPosts();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  postsContainer.querySelectorAll(".delete-comment-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const cid = button.getAttribute("data-comment-id");
      if (!cid || !confirm("Delete this comment on Instagram?")) return;
      setStatus("Deleting comment...");
      try {
        const response = await fetch(`/api/comments/${encodeURIComponent(cid)}`, {
          method: "DELETE"
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(extractErrorMessage(data, "Failed to delete comment."));
        }
        setStatus(data.message || "Comment deleted.");
        await loadPosts();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });
}

async function connectInstagram() {
  setStatus("Preparing Instagram connect flow...");
  try {
    const response = await fetch("/api/auth/url");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to create auth URL.");
    window.location.href = data.authUrl;
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loadPosts() {
  setStatus("Loading posts from Instagram...");
  try {
    const response = await fetch("/api/posts");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load posts.");
    const rows = data.data || [];
    renderPosts(rows, {
      commentsIncluded: data.commentsIncluded !== false,
      commentsErrorSummary: data.commentsErrorSummary
    });
    let statusMsg = `Loaded ${rows.length} posts.`;
    if (data.commentsIncluded === false) {
      statusMsg += " Comments skipped (permission or API error)—reconnect after enabling instagram_manage_comments.";
    }
    setStatus(statusMsg);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function publishPost(event) {
  event.preventDefault();
  setStatus("Uploading image...");
  try {
    const file = imageFileInput.files?.[0];
    if (!file) {
      throw new Error("Please select an image file first.");
    }

    const dataUrl = await fileToDataUrl(file);
    const uploadResponse = await fetch("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type,
        dataUrl
      })
    });
    const uploadData = await uploadResponse.json();
    if (!uploadResponse.ok) {
      throw new Error(extractErrorMessage(uploadData, "Image upload failed."));
    }

    const healthResponse = await fetch(`/api/health/upload?url=${encodeURIComponent(uploadData.imageUrl)}`);
    const healthData = await healthResponse.json();
    if (!healthResponse.ok || !healthData.ok) {
      throw new Error(extractErrorMessage(healthData, "Uploaded image URL is not publicly reachable."));
    }

    setStatus("Publishing post to Instagram...");
    const response = await fetch("/api/posts/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageUrl: uploadData.imageUrl,
        caption: captionInput.value.trim()
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(extractErrorMessage(data, "Publish failed."));
    setStatus("Post submitted to Instagram successfully.");
    publishForm.reset();
    await loadPosts();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

connectBtn.addEventListener("click", connectInstagram);
loadBtn.addEventListener("click", loadPosts);
publishForm.addEventListener("submit", publishPost);

if (window.location.search.includes("connected=1")) {
  setStatus("Instagram connected. You can now load and publish posts.");
}
