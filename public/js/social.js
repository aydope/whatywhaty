(() => {
  "use strict";

  const COLORS = [
    "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
    "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
    "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
    "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
    "linear-gradient(135deg, #30cfd0 0%, #330867 100%)",
  ];

  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  const nameOf = (user) => (user && (user.displayName || user.username)) || "unknown";
  const initialOf = (name) => ([...String(name || "?")][0] || "?").toUpperCase();

  const colorOf = (username = "") => {
    const hash = [...String(username)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    return COLORS[hash % COLORS.length];
  };

  const avatarHtml = (user, size = "md") => {
    const username = user?.username || "unknown";
    return `<a href="/@${esc(username)}" class="avatar-ring size-${size}" onclick="event.stopPropagation()">
      <span class="avatar-core" style="background:${colorOf(username)}">${esc(initialOf(nameOf(user)))}</span>
    </a>`;
  };

  // Twitter style header: display name, @handle and time on one line.
  const postHeaderHtml = (post, timeText) => {
    const author = post.author || {};
    const username = author.username || "unknown";
    return `<div class="post-header">
      ${avatarHtml(author)}
      <div class="post-author-info">
        <div class="post-name-line">
          <a href="/@${esc(username)}" class="post-username" onclick="event.stopPropagation()">${esc(nameOf(author))}</a>
          <span class="post-handle">@${esc(username)}</span>
          <span class="post-dot">·</span>
          <span class="post-time">${esc(timeText)}</span>
        </div>
      </div>
    </div>`;
  };

  const shareButtonHtml = (postId) =>
    `<button class="post-action-btn share" title="اشتراک‌گذاری" onclick="event.stopPropagation();Social.share('${esc(postId)}')">
      <i class="bi bi-send"></i>
    </button>`;

  const share = async (postId) => {
    const url = `${location.origin}/posts/${postId}`;
    try {
      if (navigator.share) await navigator.share({ title: "واتی‌واتی", url });
      else {
        await navigator.clipboard.writeText(url);
        if (typeof showToast === "function") showToast("لینک پست کپی شد", "success");
      }
    } catch {}
  };

  const burst = (card) => {
    const heart = document.createElement("i");
    heart.className = "bi bi-heart-fill heart-burst";
    card.appendChild(heart);
    heart.addEventListener("animationend", () => heart.remove());
  };

  // A single click opens the post, a double click (or double tap) likes it.
  const bindCard = (card, postId) => {
    let timer = null;
    const isInteractive = (e) => e.target.closest("button, a, input, textarea");

    card.addEventListener("click", (e) => {
      if (isInteractive(e) || timer) return;
      timer = setTimeout(() => {
        timer = null;
        window.Social.navigate(`/posts/${postId}`);
      }, 260);
    });

    card.addEventListener("dblclick", (e) => {
      if (isInteractive(e)) return;
      clearTimeout(timer);
      timer = null;
      burst(card);
      const likeBtn = card.querySelector(".post-action-btn");
      if (likeBtn && !likeBtn.classList.contains("liked")) likeBtn.click();
    });
  };

  window.Social = {
    navigate: (url) => {
      window.location.href = url;
    },
    esc,
    nameOf,
    initialOf,
    colorOf,
    avatarHtml,
    postHeaderHtml,
    shareButtonHtml,
    share,
    burst,
    bindCard,
  };
})();
