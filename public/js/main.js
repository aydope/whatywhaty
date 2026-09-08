let socket;
let socketInitialized = false;
let initAttempts = 0;
const MAX_INIT_ATTEMPTS = 3;

async function initializeSocket() {
  if (socketInitialized && socket?.connected) return socket;

  await tokenManager.waitForInit();
  const token = tokenManager.getAccessToken();

  if (!token) {
    setTimeout(() => initializeSocket(), 2000);
    return;
  }

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  socket = io("/", {
    auth: { token },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 20000,
  });

  socket.on("connect", () => {
    socketInitialized = true;
    socket.emit("user:active", { timestamp: Date.now() });
  });

  socket.on("connect_error", async (error) => {
    if (
      error.message.includes("auth") ||
      error.message.includes("Authentication")
    ) {
      try {
        const newToken = await tokenManager.refreshAccessToken();
        if (newToken && socket) {
          socket.auth.token = newToken;
          socket.connect();
        }
      } catch (e) {
        socketInitialized = false;
      }
    }
  });

  socket.on("disconnect", (reason) => {
    if (reason === "io server disconnect") {
      setTimeout(() => socket?.connect(), 2000);
    }
  });

  socket.on("reconnect_attempt", () => {
    const t = tokenManager.getAccessToken();
    if (t && socket) socket.auth.token = t;
  });

  socket.on("reconnect", () => {
    socketInitialized = true;
    socket.emit("user:active", { timestamp: Date.now() });
  });

  setupSocketListeners(socket);
  return socket;
}

function setupSocketListeners(socket) {
  const isPostPage = window.location.pathname.includes("/posts/");

  socket.on("post:new", (post) => {
    if (isPostPage) return;
    const container =
      document.getElementById("posts-container") ||
      document.querySelector(".posts-feed");
    if (container && !document.querySelector(`[data-post-id="${post._id}"]`)) {
      appendPost(post);
    }
  });

  socket.on("post:deleted", (data) => {
    const el = document.querySelector(`[data-post-id="${data.postId}"]`);
    if (el) {
      el.style.opacity = "0";
      el.style.transform = "scale(0.9)";
      el.style.transition = "all 0.3s";
      setTimeout(() => el.remove(), 300);
    }
  });

  socket.on("post:edited", (post) => {
    const el = document.querySelector(`[data-post-id="${post._id}"]`);
    if (el) {
      const contentEl = el.querySelector(".post-content");
      if (contentEl) {
        contentEl.textContent = post.content;
        contentEl.style.transition = "all 0.3s ease";
        contentEl.style.backgroundColor = "rgba(29,155,240,0.1)";
        setTimeout(() => {
          contentEl.style.backgroundColor = "transparent";
        }, 1000);
      }
    }
  });

  socket.on("comment:new", (data) => {
    if (isPostPage) {
      appendComment(data.comment);
    }
  });

  socket.on("post:liked", (data) => {
    updateLikeUI(data.postId, "post", data.likesCount, data.liked, data.userId);
  });

  socket.on("comment:liked", (data) => {
    updateLikeUI(
      data.commentId,
      "comment",
      data.likesCount,
      data.liked,
      data.userId,
    );
  });

  socket.on("notification:new", (notification) => {
    if (notification.type === "message") return;
    showNotificationToast(notification);
  });

  socket.on("message:new", (message) => {
    // Get current chat user from URL
    const urlParams = new URLSearchParams(window.location.search);
    const currentChatUserId = urlParams.get("user");
    const senderId = message.sender?._id || message.sender;

    // Check if we're on messages page
    const isMessagesPage = window.location.pathname.includes("/messages");

    // Show notification ONLY if:
    // 1. We're NOT on messages page OR
    // 2. We're on messages page but NOT in chat with this sender
    // (Don't show notification when we're in the same chat)
    const shouldShowNotification =
      !isMessagesPage || (isMessagesPage && currentChatUserId !== senderId);

    if (shouldShowNotification) {
      const senderName = message.sender?.username || "کاربر";
      const messageContent =
        typeof message.content === "string"
          ? message.content
          : typeof message.message === "string"
            ? message.message
            : "پیام جدید";

      const notificationData = {
        type: "message",
        sender: {
          _id: senderId,
          username: senderName,
        },
        message: messageContent,
        postId: null,
      };

      showNotificationToast(notificationData);
    }

    updateUnreadBadge();
  });

  socket.on("messages:unread_count", (data) => {
    updateUnreadBadge(data.count);
  });

  socket.on("user:online", (data) => {
    updateUserOnlineStatus(data.userId, true);
  });

  socket.on("user:offline", (data) => {
    updateUserOnlineStatus(data.userId, false);
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error.message || error);
  });
}

async function toggleLike(type, id) {
  if (!socket || !socket.connected) {
    try {
      const response = await tokenManager.fetchWithAuth(
        `/${type}s/${id}/like`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      if (!response.ok) throw new Error("Like failed: " + response.status);
      const data = await response.json();
      if (data.success) updateLikeUI(id, type, data.likesCount, data.liked);
    } catch (error) {
      console.error("Like error:", error);
      showNotificationToast({ type: "error", message: "خطا در ثبت لایک" });
    }
    return;
  }
  socket.emit(`${type}:like`, { [`${type}Id`]: id });
}

function updateLikeUI(id, type, likesCount, liked, userId) {
  const button = document.querySelector(`[data-like-${type}="${id}"]`);
  if (!button) return;

  const countSpan = button.querySelector(".likes-count");
  if (countSpan) countSpan.textContent = likesCount || 0;

  const iconEl = button.querySelector(".like-icon");
  if (iconEl) {
    iconEl.classList.toggle("liked", liked);
    iconEl.style.color = liked ? "#ed4956" : "";
  }
}

function updateUserOnlineStatus(userId, isOnline) {
  document.querySelectorAll(`[data-user-online="${userId}"]`).forEach((el) => {
    el.style.display = isOnline ? "block" : "none";
  });

  document
    .querySelectorAll(`[data-user-id="${userId}"] .online-indicator`)
    .forEach((el) => {
      el.classList.toggle("online", isOnline);
      el.classList.toggle("offline", !isOnline);
    });
}

function updateUnreadBadge(count) {
  const badge = document.getElementById("unreadBadgeNav");
  if (!badge) return;

  if (count && count > 0) {
    badge.textContent = count > 99 ? "99+" : count;
    badge.style.display = "inline-block";
  } else {
    badge.style.display = "none";
  }
}

function showNotificationToast(notification) {
  if (Notification.permission === "granted" && document.hidden) {
    const title = getNotificationTitle(notification.type);
    const body =
      typeof notification.message === "string" ? notification.message : "";
    new Notification(title, {
      body: body,
      icon: "/public/images/logo.png",
      tag: `${notification.type}-${notification.sender?._id || Date.now()}`,
    });
    return;
  }

  const toast = document.createElement("div");
  toast.className = "notification-toast";

  const senderName = notification.sender?.username || "کاربر";
  const senderId = notification.sender?._id || "";
  const link = notification.postId
    ? `/posts/${notification.postId}`
    : notification.type === "message"
      ? `/messages?user=${senderId}`
      : "#";
  const avatarColor = getAvatarColor(senderName);

  let messageText =
    typeof notification.message === "string"
      ? notification.message
      : notification.type === "message"
        ? "پیام جدید"
        : "اعلان جدید";

  messageText = messageText.split("\n")[0];

  if (messageText.length > 60) {
    messageText = messageText.substring(0, 60).trim() + "...";
  }

  toast.style.cssText = `
    position: fixed;
    bottom: 100px;
    left: 50%;
    transform: translateX(-50%);
    background: #1c1c1e;
    color: #ffffff;
    padding: 12px 16px;
    border-radius: 16px;
    font-weight: 500;
    z-index: 9999;
    animation: messageToastIn 0.3s ease;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    font-family: 'Vazirmatn', 'Sahel', sans-serif;
    font-size: 0.875rem;
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    max-width: 360px;
    min-width: 300px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    direction: rtl;
  `;

  toast.innerHTML = `
    <div style="
      width: 40px;
      height: 40px;
      background: ${avatarColor};
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      font-weight: 600;
      flex-shrink: 0;
      color: white;
    ">${senderName.charAt(0).toUpperCase()}</div>
    <div style="flex: 1; min-width: 0;">
      <div style="
        font-weight: 600;
        font-size: 0.875rem;
        color: #ffffff;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      ">@${senderName}</div>
      <div style="
        font-size: 0.8125rem;
        color: #a1a1aa;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        direction: rtl;
        margin-top: 2px;
      ">${messageText}</div>
    </div>
    <button onclick="event.stopPropagation(); this.closest('.notification-toast').remove();" style="
      background: none;
      border: none;
      color: #a1a1aa;
      cursor: pointer;
      font-size: 1.25rem;
      padding: 4px;
      flex-shrink: 0;
      transition: color 0.2s;
      line-height: 1;
    " onmouseover="this.style.color='#ffffff'"
       onmouseout="this.style.color='#a1a1aa'">&times;</button>
  `;

  toast.onclick = () => {
    if (link !== "#") {
      window.location.href = link;
    }
    toast.remove();
  };

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = "all 0.3s ease";
    toast.style.opacity = "0";
    toast.style.transform = "translateX(-50%) translateY(10px)";
    setTimeout(() => toast.remove(), 300);
  }, 4000);

  if (!document.getElementById("toast-animations")) {
    const style = document.createElement("style");
    style.id = "toast-animations";
    style.textContent = `
      @keyframes messageToastIn {
        from {
          opacity: 0;
          transform: translateX(-50%) translateY(20px);
        }
        to {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
      }
    `;
    document.head.appendChild(style);
  }
}

function getNotificationTitle(type) {
  const titles = {
    comment: "💬 کامنت جدید",
    reply: "💬 پاسخ جدید",
    like: "❤️ لایک جدید",
    like_comment: "❤️ لایک کامنت",
    follow: "👤 دنبال‌کننده جدید",
    message: "📨 پیام جدید",
    error: "⚠️ خطا",
    success: "✅ موفق",
  };
  return titles[type] || "اعلان جدید";
}

function getAvatarColor(username) {
  const colors = [
    "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
    "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
    "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
    "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
    "linear-gradient(135deg, #30cfd0 0%, #330867 100%)",
  ];

  const hash = username
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

function appendPost(post) {
  const postsContainer =
    document.getElementById("posts-container") ||
    document.querySelector(".posts-feed");
  if (!postsContainer || document.querySelector(`[data-post-id="${post._id}"]`))
    return;

  const el = document.createElement("div");
  el.className = "post-card";
  el.setAttribute("data-post-id", post._id);
  el.style.animation = "slideIn 0.3s ease";

  const name = post.author?.username || "unknown";
  const avatarColor = getAvatarColor(name);

  el.innerHTML = `
    <div class="post-header">
      <div class="post-avatar" style="background: ${avatarColor};">
        <span>${name.charAt(0).toUpperCase()}</span>
      </div>
      <div class="post-author-info">
        <a href="/@${name}" class="post-author">@${name}</a>
        <span class="post-time">${timeAgoFormat(post.createdAt)}</span>
      </div>
    </div>
    <div class="post-content">${escapeHtml(post.content || "")}</div>
    <div class="post-actions">
      <button class="action-btn like-btn" data-like-post="${post._id}" onclick="toggleLike('post','${post._id}')">
        <span class="like-icon">❤</span>
        <span class="likes-count">${post.likesCount || 0}</span>
      </button>
      <button class="action-btn comment-btn" onclick="window.location.href='/posts/${post._id}'">
        <span>💬</span>
        <span>${post.commentsCount || 0}</span>
      </button>
      <button class="action-btn share-btn" onclick="sharePost('${post._id}')">
        <span>↗</span>
      </button>
    </div>
  `;

  postsContainer.insertBefore(el, postsContainer.firstChild);

  setTimeout(() => {
    el.style.transition = "all 0.5s ease";
    el.style.boxShadow = "0 0 0 2px rgba(29,155,240,0.3)";
    setTimeout(() => {
      el.style.boxShadow = "";
    }, 1500);
  }, 100);
}

function appendComment(comment) {
  const container =
    document.getElementById("comments-container") ||
    document.querySelector(".comments-list");
  if (
    !container ||
    document.querySelector(`[data-comment-id="${comment._id}"]`)
  )
    return;

  const el = document.createElement("div");
  el.className = "comment-item";
  el.setAttribute("data-comment-id", comment._id);
  el.style.animation = "slideIn 0.3s ease";

  const name = comment.author?.username || "unknown";
  const avatarColor = getAvatarColor(name);

  el.innerHTML = `
    <div class="comment-avatar" style="background: ${avatarColor};">
      ${name.charAt(0).toUpperCase()}
    </div>
    <div class="comment-body">
      <div class="comment-header">
        <a href="/users/${name}" class="comment-author">@${name}</a>
        <span class="comment-time">${timeAgoFormat(comment.createdAt)}</span>
      </div>
      <div class="comment-content">${escapeHtml(comment.content || "")}</div>
      <div class="comment-actions">
        <button class="action-btn like-btn" data-like-comment="${comment._id}" onclick="toggleLike('comment','${comment._id}')">
          <span class="like-icon">❤</span>
          <span class="likes-count">${comment.likesCount || 0}</span>
        </button>
      </div>
    </div>
  `;

  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function sharePost(postId) {
  const url = `${window.location.origin}/posts/${postId}`;
  if (navigator.share) {
    navigator.share({ title: "واتی‌واتی", url }).catch(() => {});
  } else {
    navigator.clipboard
      .writeText(url)
      .then(() =>
        showNotificationToast({ type: "success", message: "لینک پست کپی شد" }),
      )
      .catch(() =>
        showNotificationToast({ type: "error", message: "خطا در کپی لینک" }),
      );
  }
}

function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function timeAgoFormat(date) {
  if (!date) return "";
  const now = new Date();
  const past = new Date(date);
  const diffSec = Math.floor((now - past) / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "همین الان";
  if (diffMin < 60) return `${diffMin} دقیقه پیش`;
  if (diffHour < 24) return `${diffHour} ساعت پیش`;
  if (diffDay < 7) return `${diffDay} روز پیش`;
  return past.toLocaleDateString("fa-IR-u-num-latn");
}

function initInfiniteScroll(containerSelector, loadMoreFn) {
  const container = document.querySelector(containerSelector);
  if (!container) return;

  let loading = false;
  let hasMore = true;
  let page = 1;

  const sentinel = document.createElement("div");
  sentinel.style.height = "1px";
  sentinel.style.width = "100%";
  container.appendChild(sentinel);

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !loading && hasMore) {
          loading = true;
          page++;

          loadMoreFn(page)
            .then((result) => {
              hasMore = result?.hasMore !== false;
              if (!hasMore) sentinel.remove();
            })
            .catch(() => page--)
            .finally(() => (loading = false));
        }
      });
    },
    { rootMargin: "300px" },
  );

  observer.observe(sentinel);
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

async function initializeApp() {
  try {
    const isAuthenticated = await tokenManager.waitForInit();
    if (!isAuthenticated) {
      if (initAttempts < MAX_INIT_ATTEMPTS) {
        initAttempts++;
        setTimeout(initializeApp, 2000);
      }
      return;
    }

    await initializeSocket();
    requestNotificationPermission();

    const currentPath = window.location.pathname;
    if (currentPath === "/" || currentPath === "/explore") {
      initInfiniteScroll("#posts-container, .posts-feed", async (page) => {
        const response = await tokenManager.fetchWithAuth(
          `/posts/explore?page=${page}`,
        );
        const data = await response.json();
        if (data.success && data.posts) {
          data.posts.forEach((post) => appendPost(post));
        }
        return data;
      });
    }
  } catch (error) {
    if (initAttempts < MAX_INIT_ATTEMPTS) {
      initAttempts++;
      setTimeout(initializeApp, 3000);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(initializeApp, 100);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && socket && !socket.connected) {
    socket.connect();
  }
});

window.socketAPI = {
  getSocket: () => socket,
  initializeSocket,
  toggleLike,
};
