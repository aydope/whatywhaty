(() => {
  "use strict";

  const ME = {
    id: document.body.dataset.userId,
    username: document.body.dataset.username,
  };
  const PAGE_SIZE = 30;
  const MAX_IN_MEMORY = 300;
  const GROUP_GAP_MS = 5 * 60 * 1000;
  const NEAR_BOTTOM_PX = 120;
  const isTouch = window.matchMedia("(pointer: coarse)").matches;

  const $ = (id) => document.getElementById(id);
  const els = {
    sidebar: $("sidebar"),
    chatArea: $("chatArea"),
    convContainer: $("conversationsContainer"),
    searchInput: $("searchUserInput"),
    searchClear: $("searchClearBtn"),
    searchOverlay: $("searchResultsOverlay"),
    searchContent: $("searchResultsContent"),
    header: $("chatHeader"),
    username: $("chatUsername"),
    handle: $("chatHandle"),
    avatar: $("avatarLetter"),
    onlineDot: $("onlineDot"),
    statusText: $("statusText"),
    typingIndicator: $("typingHeaderIndicator"),
    profileLink: $("chatProfileLink"),
    profileLinkText: $("chatProfileLinkText"),
    pinnedBar: $("pinnedBar"),
    pinnedTitle: $("pinnedTitle"),
    pinnedText: $("pinnedText"),
    pinnedUnpin: $("pinnedUnpinBtn"),
    blockedNotice: $("blockedNotice"),
    blockedByYouNotice: $("blockedByYouNotice"),
    unblockBtn: $("unblockBtn"),
    empty: $("chatEmpty"),
    wrap: $("messagesWrap"),
    list: $("messagesContainer"),
    scrollDown: $("scrollDownBtn"),
    scrollBadge: $("scrollDownBadge"),
    replyBar: $("replyBar"),
    replyName: $("replyName"),
    replyText: $("replyText"),
    replyCancel: $("replyCancelBtn"),
    inputArea: $("messageInputArea"),
    input: $("messageText"),
    sendBtn: $("sendBtn"),
    menu: $("contextMenu"),
    modal: $("confirmDeleteModal"),
    forBoth: $("forBothCheckbox"),
    forBothLabel: $("forBothLabel"),
    confirmDelete: $("confirmDeleteBtn"),
    cancelDelete: $("cancelDeleteBtn"),
    toasts: $("toastContainer"),
  };

  const state = {
    conversations: [],
    peer: null, // { id, username, isOnline, isBlockedByYou, isBlockedByThem }
    messages: [],
    hasMoreOlder: false,
    hasMoreNewer: false,
    loadingOlder: false,
    loadingNewer: false,
    pinned: [],
    pinnedIndex: 0,
    reply: null,
    newCount: 0,
    online: new Set(),
    watched: new Set(),
    typing: new Set(),
    openToken: 0,
    deleteTarget: null,
    animateId: null,
    connectedOnce: false,
  };

  // ---------------------------------------------------------------- helpers

  const escapeHtml = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  // Only http(s) links are turned into anchors, and the text is escaped first.
  const linkify = (escaped) =>
    escaped.replace(/\bhttps?:\/\/[^\s<]+/gi, (match) => {
      const url = match.replace(/[.,!?;:)\]}،؛]+$/, "");
      const rest = match.slice(url.length);
      return `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>${rest}`;
    });

  const timeFormat = new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const dayFormat = new Intl.DateTimeFormat("fa-IR", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const shortDayFormat = new Intl.DateTimeFormat("fa-IR", {
    month: "short",
    day: "numeric",
  });

  const dayKey = (date) =>
    `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

  const dayLabel = (date) => {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (dayKey(date) === dayKey(today)) return "امروز";
    if (dayKey(date) === dayKey(yesterday)) return "دیروز";
    return dayFormat.format(date);
  };

  const listTime = (value) => {
    const date = new Date(value);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (dayKey(date) === dayKey(today)) return timeFormat.format(date);
    if (dayKey(date) === dayKey(yesterday)) return "دیروز";
    return shortDayFormat.format(date);
  };

  // Display name when set, otherwise the @id; and the first letter for avatars.
  const labelOf = (user) => user?.displayName || user?.username || "";
  const initialOf = (user) => ([...labelOf(user)][0] || "?").toUpperCase();

  const idOf = (value) => (value && typeof value === "object" ? value._id : value);
  const senderOf = (message) => idOf(message.sender);
  const isMine = (message) => senderOf(message) === ME.id;
  const isPending = (message) => String(message._id).startsWith("tmp-");

  const toast = (text, type = "error") => {
    const el = document.createElement("div");
    el.className = `tg-toast ${type}`;
    el.textContent = text;
    els.toasts.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      window.location.href = "/auth/login";
      throw new Error("unauthorized");
    }

    let data = null;
    try {
      data = await res.json();
    } catch {}

    if (!res.ok || !data?.success) {
      const error = new Error(data?.message || "خطا در ارتباط با سرور");
      error.status = res.status;
      throw error;
    }
    return data;
  }

  const debounce = (fn, ms) => {
    let timer;
    let pending = null;
    const debounced = (...args) => {
      clearTimeout(timer);
      pending = args;
      timer = setTimeout(() => {
        pending = null;
        fn(...args);
      }, ms);
    };
    // Runs the waiting call right away and resolves when it has finished.
    debounced.flush = async () => {
      clearTimeout(timer);
      const args = pending || [];
      pending = null;
      await fn(...args);
    };
    return debounced;
  };

  const isVisible = () => !document.hidden;

  // ---------------------------------------------------------------- socket

  const socket = io({
    transports: ["websocket", "polling"],
    reconnectionDelayMax: 10000,
  });

  const watchPresence = (ids) => {
    const fresh = ids.filter((id) => id && !state.watched.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => state.watched.add(id));
    socket.emit("presence:watch", { userIds: fresh }, (res) => {
      if (!res?.success) return;
      res.online.forEach((id) => state.online.add(id));
      renderConversations();
      renderHeaderStatus();
    });
  };

  // --------------------------------------------------------- conversations

  const conversationOf = (peerId) =>
    state.conversations.find((c) => c._id === peerId);

  function renderConversations() {
    const query = els.searchInput.value.trim();
    if (query) return;

    if (!state.conversations.length) {
      els.convContainer.innerHTML =
        '<div class="tg-search-empty"><span class="material-symbols-rounded">chat</span><div>هنوز گفتگویی ندارید</div><div style="font-size:13px;margin-top:4px">با جستجوی نام کاربری گفتگو را شروع کنید</div></div>';
      return;
    }

    els.convContainer.innerHTML = state.conversations
      .map((conv) => {
        const user = conv.user;
        const last = conv.lastMessage;
        const mine = last && senderOf(last) === ME.id;
        const typing = state.typing.has(conv._id);
        const tick = mine
          ? `<span class="material-symbols-rounded conv-tick ${last.isRead ? "read" : ""}">${last.isRead ? "done_all" : "done"}</span>`
          : "";
        const text = typing
          ? '<span class="conv-text conv-typing">در حال تایپ...</span>'
          : `<span class="conv-text">${mine ? "شما: " : ""}${escapeHtml(last?.content || "")}</span>`;
        const badges = [
          user.isBlockedByThem ? '<span class="badge-blocked">بلاک‌شده</span>' : "",
          user.isBlockedByYou ? '<span class="badge-blocked-you">بلاک کرده‌اید</span>' : "",
        ].join("");

        return `<div class="tg-conv-item ${state.peer?.id === conv._id ? "active" : ""}" data-peer="${conv._id}" data-name="${escapeHtml(user.username)}" data-display="${escapeHtml(user.displayName || "")}">
          <div class="tg-avatar">${escapeHtml(initialOf(user))}
            ${state.online.has(conv._id) ? '<div class="tg-online-dot"></div>' : ""}
          </div>
          <div class="tg-conv-info">
            <div class="tg-conv-name">${escapeHtml(labelOf(user))} ${badges}</div>
            <div class="tg-conv-last">${tick}${text}</div>
          </div>
          <div class="tg-conv-meta">
            <span class="tg-conv-time">${last ? listTime(last.createdAt) : ""}</span>
            ${conv.unreadCount > 0 ? `<span class="tg-unread-badge">${conv.unreadCount > 99 ? "99+" : conv.unreadCount}</span>` : ""}
          </div>
        </div>`;
      })
      .join("");
  }

  async function loadConversations() {
    try {
      const data = await api("GET", "/messages/conversations");
      state.conversations = data.conversations;
      data.conversations.forEach((c) => {
        if (c.user.isOnline) state.online.add(c._id);
        else state.online.delete(c._id);
      });
      renderConversations();
      watchPresence(data.conversations.map((c) => c._id));
    } catch (error) {
      if (error.message !== "unauthorized") toast("خطا در دریافت گفتگوها");
    }
  }
  const loadConversationsSoon = debounce(loadConversations, 400);

  function touchConversation(peerId, peerUser, message, { unreadDelta = 0 } = {}) {
    let conv = conversationOf(peerId);
    if (!conv) {
      conv = {
        _id: peerId,
        unreadCount: 0,
        user: {
          _id: peerId,
          username: peerUser.username,
          displayName: peerUser.displayName || "",
          isOnline: state.online.has(peerId),
          isBlockedByYou: false,
          isBlockedByThem: false,
        },
      };
      state.conversations.unshift(conv);
      watchPresence([peerId]);
    }
    conv.lastMessage = {
      _id: message._id,
      content: message.content,
      createdAt: message.createdAt,
      isRead: message.isRead,
      sender: senderOf(message),
    };
    conv.unreadCount = Math.max(0, conv.unreadCount + unreadDelta);
    state.conversations = [conv, ...state.conversations.filter((c) => c !== conv)];
    renderConversations();
  }

  // ----------------------------------------------------------------- list

  const distanceFromBottom = () =>
    els.list.scrollHeight - els.list.scrollTop - els.list.clientHeight;
  const isNearBottom = () => distanceFromBottom() < NEAR_BOTTOM_PX;

  const peerName = () => labelOf(state.peer);

  function replyPreviewHtml(message) {
    const reply = message.replyTo;
    if (!reply) return "";
    if (reply.deleted) {
      return `<div class="tg-reply-quote is-deleted"><div class="q-text">پیام حذف شده است</div></div>`;
    }
    const name = idOf(reply.sender) === ME.id ? "شما" : peerName();
    return `<div class="tg-reply-quote" data-jump="${reply._id}">
      <div class="q-name">${escapeHtml(name)}</div>
      <div class="q-text">${escapeHtml(reply.content)}</div>
    </div>`;
  }

  function ticksHtml(message) {
    if (!isMine(message)) return "";
    if (message.failed) {
      return '<span class="material-symbols-rounded tg-tick" data-retry="1" title="ارسال نشد، برای تلاش دوباره بزنید">error</span>';
    }
    if (message.pending) return '<span class="material-symbols-rounded tg-tick">schedule</span>';
    return `<span class="material-symbols-rounded tg-tick">${message.isRead ? "done_all" : "done"}</span>`;
  }

  function messageHtml(message, { first, last }) {
    const mine = isMine(message);
    const classes = [
      "tg-msg-wrap",
      mine ? "sent" : "received",
      first ? "first" : "",
      last ? "last" : "",
      message.isRead ? "is-read" : "",
      message.pending ? "pending" : "",
      message.failed ? "failed" : "",
      state.animateId === message._id ? "anim" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return `<div class="${classes}" data-id="${message._id}">
      <span class="material-symbols-rounded swipe-hint">reply</span>
      <div class="tg-msg-bubble">
        ${replyPreviewHtml(message)}
        <div class="tg-msg-text" dir="auto">${linkify(escapeHtml(message.content))}</div>
        <span class="tg-msg-meta">
          ${message.pinned ? '<span class="material-symbols-rounded">keep</span>' : ""}
          <span class="tg-msg-time">${timeFormat.format(new Date(message.createdAt))}</span>
          ${ticksHtml(message)}
        </span>
      </div>
    </div>`;
  }

  // Rebuilds the visible list. `mode` decides where the scroll position ends
  // up: "bottom", "keep", "prepend" (older page added) or a message id.
  function renderMessages(mode = "keep") {
    const prevHeight = els.list.scrollHeight;
    const prevTop = els.list.scrollTop;
    const parts = [];

    if (state.hasMoreOlder) parts.push('<div class="tg-load-more">در حال بارگذاری...</div>');

    let currentDay = null;
    let dayHtml = "";
    const flush = () => {
      if (dayHtml) parts.push(`<div class="tg-day">${dayHtml}</div>`);
      dayHtml = "";
    };

    state.messages.forEach((message, i) => {
      const date = new Date(message.createdAt);
      const prev = state.messages[i - 1];
      const next = state.messages[i + 1];
      const sameGroup = (a, b) =>
        a &&
        b &&
        senderOf(a) === senderOf(b) &&
        dayKey(new Date(a.createdAt)) === dayKey(new Date(b.createdAt)) &&
        Math.abs(new Date(b.createdAt) - new Date(a.createdAt)) < GROUP_GAP_MS;

      if (dayKey(date) !== currentDay) {
        flush();
        currentDay = dayKey(date);
        dayHtml = `<div class="tg-date-divider"><span>${dayLabel(date)}</span></div>`;
      }
      dayHtml += messageHtml(message, {
        first: !sameGroup(prev, message),
        last: !sameGroup(message, next),
      });
    });
    flush();

    if (!state.messages.length) {
      parts.push('<div class="tg-chat-hint">هنوز پیامی ارسال نشده است. سلام کنید!</div>');
    }

    els.list.innerHTML = parts.join("");
    state.animateId = null;

    if (mode === "bottom") {
      els.list.scrollTop = els.list.scrollHeight;
    } else if (mode === "prepend") {
      els.list.scrollTop = prevTop + (els.list.scrollHeight - prevHeight);
    } else if (mode === "keep") {
      els.list.scrollTop = prevTop;
    } else {
      scrollToMessage(mode, false);
    }
    updateScrollButton();
  }

  function scrollToMessage(id, smooth = true) {
    const el = els.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    return true;
  }

  function updateScrollButton() {
    const show = distanceFromBottom() > 300 || state.hasMoreNewer;
    els.scrollDown.classList.toggle("show", show);
    els.scrollBadge.hidden = state.newCount === 0;
    els.scrollBadge.textContent = state.newCount > 99 ? "99+" : state.newCount;
  }

  const findMessage = (id) => state.messages.find((m) => m._id === id);
  const lastRealId = () =>
    [...state.messages].reverse().find((m) => !isPending(m))?._id;
  const firstRealId = () => state.messages.find((m) => !isPending(m))?._id;

  function upsertMessage(message) {
    const index = state.messages.findIndex((m) => m._id === message._id);
    if (index >= 0) state.messages[index] = { ...state.messages[index], ...message };
    else state.messages.push(message);
  }

  function removeMessage(id) {
    const before = state.messages.length;
    state.messages = state.messages.filter((m) => m._id !== id);
    state.pinned = state.pinned.filter((m) => m._id !== id);
    if (state.reply?._id === id) cancelReply();
    if (state.messages.length !== before) renderMessages("keep");
    renderPinned();
  }

  function trimIfLong() {
    if (state.messages.length > MAX_IN_MEMORY && isNearBottom() && !state.hasMoreNewer) {
      state.messages = state.messages.slice(-Math.floor(MAX_IN_MEMORY * 0.7));
      state.hasMoreOlder = true;
    }
  }

  // -------------------------------------------------------------- paging

  async function loadOlder() {
    if (!state.hasMoreOlder || state.loadingOlder || !state.peer) return;
    const before = firstRealId();
    if (!before) return;
    state.loadingOlder = true;
    const token = state.openToken;
    try {
      const data = await api("GET", `/messages/${state.peer.id}?limit=${PAGE_SIZE}&before=${before}`);
      if (token !== state.openToken) return;
      state.messages = [...data.messages, ...state.messages];
      state.hasMoreOlder = data.hasMoreOlder;
      renderMessages("prepend");
    } catch {
      toast("خطا در دریافت پیام‌های قبلی");
    } finally {
      state.loadingOlder = false;
    }
  }

  async function loadNewer() {
    if (!state.hasMoreNewer || state.loadingNewer || !state.peer) return;
    const after = lastRealId();
    if (!after) return;
    state.loadingNewer = true;
    const token = state.openToken;
    try {
      const data = await api("GET", `/messages/${state.peer.id}?limit=${PAGE_SIZE}&after=${after}`);
      if (token !== state.openToken) return;
      data.messages.forEach(upsertMessage);
      state.hasMoreNewer = data.hasMoreNewer;
      renderMessages("keep");
      if (!state.hasMoreNewer) markReadSoon();
    } catch {
      toast("خطا در دریافت پیام‌های جدید");
    } finally {
      state.loadingNewer = false;
    }
  }

  async function goToLatest() {
    if (!state.peer) return;
    if (!state.hasMoreNewer) {
      els.list.scrollTo({ top: els.list.scrollHeight, behavior: "smooth" });
      return;
    }
    const token = state.openToken;
    try {
      const data = await api("GET", `/messages/${state.peer.id}?limit=${PAGE_SIZE}`);
      if (token !== state.openToken) return;
      state.messages = data.messages;
      state.hasMoreOlder = data.hasMoreOlder;
      state.hasMoreNewer = false;
      state.newCount = 0;
      renderMessages("bottom");
      markReadSoon();
    } catch {
      toast("خطا در دریافت پیام‌ها");
    }
  }

  async function jumpTo(id) {
    if (!state.peer) return;
    if (findMessage(id) && scrollToMessage(id)) return;
    const token = state.openToken;
    try {
      const data = await api("GET", `/messages/${state.peer.id}?limit=${PAGE_SIZE}&around=${id}`);
      if (token !== state.openToken) return;
      if (!data.messages.some((m) => m._id === id)) {
        toast("این پیام دیگر وجود ندارد");
        return;
      }
      state.messages = data.messages;
      state.hasMoreOlder = data.hasMoreOlder;
      state.hasMoreNewer = data.hasMoreNewer;
      renderMessages(id);
    } catch {
      toast("خطا در یافتن پیام");
    }
  }

  // --------------------------------------------------------------- header

  function renderHeaderStatus() {
    if (!state.peer) return;
    const online = state.online.has(state.peer.id);
    els.onlineDot.style.display = online ? "block" : "none";
    els.statusText.textContent = online ? "آنلاین" : "آفلاین";
    els.statusText.style.color = online ? "var(--success-color)" : "";
    const typing = state.typing.has(state.peer.id);
    els.typingIndicator.style.display = typing ? "inline-flex" : "none";
    els.statusText.style.display = typing ? "none" : "inline";
  }

  function renderBlockState() {
    const peer = state.peer;
    const byThem = !!peer?.isBlockedByThem;
    const byYou = !!peer?.isBlockedByYou;
    els.blockedNotice.style.display = byThem ? "flex" : "none";
    els.blockedByYouNotice.style.display = byYou && !byThem ? "flex" : "none";
    els.inputArea.style.display = peer && !byThem && !byYou ? "flex" : "none";
    if (byThem || byYou) cancelReply();
  }

  // ---------------------------------------------------------------- pins

  function renderPinned() {
    if (!state.pinned.length) {
      els.pinnedBar.hidden = true;
      return;
    }
    state.pinnedIndex = state.pinnedIndex % state.pinned.length;
    const current = state.pinned[state.pinnedIndex];
    els.pinnedBar.hidden = false;
    els.pinnedTitle.textContent =
      state.pinned.length > 1
        ? `پیام پین‌شده #${state.pinned.length - state.pinnedIndex}`
        : "پیام پین‌شده";
    els.pinnedText.textContent = current.content;
  }

  async function refreshPinned() {
    if (!state.peer) return;
    try {
      const data = await api("GET", `/messages/${state.peer.id}?limit=1`);
      state.pinned = data.pinned || [];
      renderPinned();
    } catch {}
  }

  async function togglePin(message) {
    try {
      await api("PUT", `/messages/${message._id}/pin`, { pinned: !message.pinned });
    } catch (error) {
      toast(error.message);
    }
  }

  function applyPinEvent(data) {
    if (state.peer?.id !== data.peerId) return;
    const message = findMessage(data.messageId);
    if (message) {
      message.pinned = data.pinned;
      message.pinnedAt = data.pinnedAt;
    }
    if (!data.pinned) {
      state.pinned = state.pinned.filter((m) => m._id !== data.messageId);
    } else if (message) {
      state.pinned = [message, ...state.pinned.filter((m) => m._id !== message._id)];
      state.pinnedIndex = 0;
    } else {
      refreshPinned();
    }
    renderPinned();
    if (message) renderMessages("keep");
  }

  // ---------------------------------------------------------------- reply

  function startReply(message) {
    if (!state.peer || isPending(message)) return;
    state.reply = message;
    els.replyName.textContent = isMine(message) ? "شما" : peerName();
    els.replyText.textContent = message.content;
    els.replyBar.hidden = false;
    els.input.focus();
  }

  function cancelReply() {
    state.reply = null;
    els.replyBar.hidden = true;
  }

  // ----------------------------------------------------------------- send

  async function deliver(temp) {
    const peerId = temp.recipient;
    try {
      const data = await api("POST", `/messages/${peerId}`, {
        content: temp.content,
        replyTo: temp.replyId || null,
      });
      if (state.peer?.id !== peerId) {
        loadConversationsSoon();
        return;
      }
      const index = state.messages.findIndex((m) => m._id === temp._id);
      const alreadyThere = state.messages.some((m) => m._id === data.message._id);
      if (index >= 0) {
        if (alreadyThere) state.messages.splice(index, 1);
        else state.messages[index] = data.message;
      }
      renderMessages("keep");
      touchConversation(peerId, state.peer, data.message);
    } catch (error) {
      if (error.status === 403 && state.peer?.id === peerId) {
        state.messages = state.messages.filter((m) => m._id !== temp._id);
        if (/بلاک شده/.test(error.message)) state.peer.isBlockedByThem = true;
        if (/بلاک کرده/.test(error.message)) state.peer.isBlockedByYou = true;
        renderBlockState();
        renderMessages("keep");
        toast(error.message);
        return;
      }
      const stored = findMessage(temp._id);
      if (stored) {
        stored.pending = false;
        stored.failed = true;
        renderMessages("keep");
      }
    }
  }

  function sendMessage() {
    const content = els.input.value.trim();
    if (!content || !state.peer || state.peer.isBlockedByThem || state.peer.isBlockedByYou) return;

    const temp = {
      _id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sender: ME.id,
      recipient: state.peer.id,
      content,
      type: "text",
      isRead: false,
      pinned: false,
      pending: true,
      createdAt: new Date().toISOString(),
      replyId: state.reply?._id || null,
      replyTo: state.reply
        ? { _id: state.reply._id, deleted: false, sender: senderOf(state.reply), content: state.reply.content }
        : null,
    };

    state.messages.push(temp);
    state.animateId = temp._id;
    els.input.value = "";
    autosize();
    cancelReply();
    stopTyping();
    state.newCount = 0;
    trimIfLong();
    renderMessages("bottom");
    deliver(temp);
    if (!isTouch) els.input.focus();
  }

  function retry(id) {
    const temp = findMessage(id);
    if (!temp || !temp.failed) return;
    temp.failed = false;
    temp.pending = true;
    renderMessages("keep");
    deliver(temp);
  }

  // --------------------------------------------------------------- reading

  const markReadSoon = debounce(() => {
    if (!state.peer || !isVisible() || state.hasMoreNewer || !isNearBottom()) return;
    const conv = conversationOf(state.peer.id);
    const unreadHere = state.messages.some((m) => !isMine(m) && !m.isRead && !isPending(m));
    if (!unreadHere && !(conv && conv.unreadCount > 0)) return;

    state.messages.forEach((m) => {
      if (!isMine(m)) m.isRead = true;
    });
    if (conv) {
      conv.unreadCount = 0;
      renderConversations();
    }
    state.newCount = 0;
    updateScrollButton();

    if (socket.connected) socket.emit("message:read", { userId: state.peer.id });
    else api("PUT", `/messages/${state.peer.id}/read-all`).catch(() => {});
  }, 150);

  // ------------------------------------------------------------- open chat

  function renderPeerIdentity() {
    const peer = state.peer;
    if (!peer) return;
    els.username.textContent = labelOf(peer);
    els.handle.textContent = `@${peer.username}`;
    els.avatar.textContent = initialOf(peer);
  }

  async function openConversation(peerId, username, displayName = "") {
    if (state.peer?.id === peerId) {
      els.chatArea.classList.add("chat-open");
      els.sidebar.classList.add("chat-open");
      return;
    }

    const token = ++state.openToken;
    state.peer = {
      id: peerId,
      username,
      displayName,
      isOnline: state.online.has(peerId),
      isBlockedByYou: false,
      isBlockedByThem: false,
    };
    state.messages = [];
    state.pinned = [];
    state.pinnedIndex = 0;
    state.hasMoreOlder = false;
    state.hasMoreNewer = false;
    state.newCount = 0;
    cancelReply();
    closeMenu();

    els.sidebar.classList.add("chat-open");
    els.chatArea.classList.add("chat-open");
    els.empty.style.display = "none";
    els.header.style.display = "flex";
    els.wrap.style.display = "flex";
    renderPeerIdentity();
    els.profileLink.href = els.profileLinkText.href = `/@${encodeURIComponent(username)}`;
    els.list.innerHTML = '<div class="tg-chat-hint">در حال بارگذاری...</div>';
    renderPinned();
    renderHeaderStatus();
    renderBlockState();
    renderConversations();
    history.replaceState(null, "", `/messages?user=${peerId}`);
    watchPresence([peerId]);

    try {
      const data = await api("GET", `/messages/${peerId}?limit=${PAGE_SIZE}`);
      if (token !== state.openToken) return;

      state.messages = data.messages;
      state.pinned = data.pinned || [];
      state.hasMoreOlder = data.hasMoreOlder;
      state.hasMoreNewer = data.hasMoreNewer;
      Object.assign(state.peer, {
        username: data.recipient.username,
        displayName: data.recipient.displayName || "",
        isBlockedByYou: data.recipient.isBlockedByYou,
        isBlockedByThem: false,
      });
      if (data.recipient.isOnline) state.online.add(peerId);

      renderPeerIdentity();
      renderBlockState();
      renderHeaderStatus();
      renderPinned();
      renderMessages("bottom");
      markReadSoon();
      if (!isTouch && !state.peer.isBlockedByYou) els.input.focus();
    } catch (error) {
      if (token !== state.openToken) return;
      if (error.status === 403) {
        state.peer.isBlockedByThem = true;
        els.list.innerHTML = "";
        renderBlockState();
        return;
      }
      els.list.innerHTML = '<div class="tg-chat-hint">خطا در دریافت پیام‌ها</div>';
      toast(error.message);
    }
  }

  function closeChat() {
    state.openToken++;
    state.peer = null;
    state.messages = [];
    cancelReply();
    els.sidebar.classList.remove("chat-open");
    els.chatArea.classList.remove("chat-open");
    els.header.style.display = "none";
    els.wrap.style.display = "none";
    els.inputArea.style.display = "none";
    els.pinnedBar.hidden = true;
    els.blockedNotice.style.display = "none";
    els.blockedByYouNotice.style.display = "none";
    els.empty.style.display = "flex";
    history.replaceState(null, "", "/messages");
    renderConversations();
  }

  // ----------------------------------------------------------- context menu

  function closeMenu() {
    els.menu.classList.remove("show");
    els.menu.innerHTML = "";
    els.menu.dataset.id = "";
  }

  function openMenu(message, x, y) {
    const items = [];
    if (!isPending(message) && !message.failed) {
      items.push(["reply", "reply", "پاسخ"]);
    }
    items.push(["copy", "content_copy", "کپی"]);
    if (!isPending(message) && !message.failed) {
      items.push(["pin", message.pinned ? "keep_off" : "keep", message.pinned ? "برداشتن پین" : "پین کردن"]);
    }
    items.push(["delete", "delete", "حذف", true]);

    els.menu.innerHTML = items
      .map(
        ([action, icon, label, danger]) =>
          `<button class="tg-context-item ${danger ? "danger" : ""}" data-action="${action}" role="menuitem">
            <span class="material-symbols-rounded" style="font-size:20px">${icon}</span>${label}
          </button>`,
      )
      .join("");
    els.menu.dataset.id = message._id;
    els.menu.classList.add("show");

    const { offsetWidth: w, offsetHeight: h } = els.menu;
    els.menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
    els.menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast("کپی شد", "success");
  }

  function runMenuAction(action, message) {
    if (action === "reply") startReply(message);
    else if (action === "copy") copyText(message.content);
    else if (action === "pin") togglePin(message);
    else if (action === "delete") askDelete(message);
  }

  // ---------------------------------------------------------------- delete

  function askDelete(message) {
    if (message.failed || isPending(message)) {
      state.messages = state.messages.filter((m) => m._id !== message._id);
      renderMessages("keep");
      return;
    }
    state.deleteTarget = message;
    els.forBoth.checked = false;
    els.forBothLabel.textContent = `حذف برای ${peerName()} هم`;
    els.modal.classList.add("active");
  }

  function closeDeleteModal() {
    els.modal.classList.remove("active");
    state.deleteTarget = null;
  }

  async function confirmDelete() {
    const message = state.deleteTarget;
    if (!message) return;
    const forBoth = els.forBoth.checked;
    closeDeleteModal();

    try {
      await api("DELETE", `/messages/${message._id}`, { forBoth });
      removeMessage(message._id);
      loadConversationsSoon();
    } catch (error) {
      toast(error.message);
    }
  }

  // ----------------------------------------------------------------- input

  function autosize() {
    els.input.style.height = "auto";
    els.input.style.height = `${Math.min(els.input.scrollHeight, 120)}px`;
  }

  let lastTypingEmit = 0;
  let typingStopTimer;

  function stopTyping() {
    clearTimeout(typingStopTimer);
    if (lastTypingEmit && state.peer && socket.connected) {
      socket.emit("typing:stop", { recipientId: state.peer.id });
    }
    lastTypingEmit = 0;
  }

  function handleTyping() {
    autosize();
    if (!state.peer || !els.input.value.trim()) return stopTyping();
    const now = Date.now();
    if (now - lastTypingEmit > 2500 && socket.connected) {
      socket.emit("typing:start", { recipientId: state.peer.id });
      lastTypingEmit = now;
    }
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(stopTyping, 3000);
  }

  // ---------------------------------------------------------------- search

  function clearSearch() {
    els.searchInput.value = "";
    els.searchClear.classList.remove("show");
    els.searchOverlay.classList.remove("show");
    renderConversations();
  }

  const runSearch = debounce(async () => {
    const query = els.searchInput.value.trim();
    if (query.length < 2) {
      els.searchOverlay.classList.remove("show");
      renderConversations();
      return;
    }
    try {
      const data = await api("GET", `/users/search?q=${encodeURIComponent(query)}`);
      if (query !== els.searchInput.value.trim()) return;
      const highlight = (name) => {
        const at = name.toLowerCase().indexOf(query.toLowerCase());
        if (at < 0) return escapeHtml(name);
        return (
          escapeHtml(name.slice(0, at)) +
          `<span class="highlight">${escapeHtml(name.slice(at, at + query.length))}</span>` +
          escapeHtml(name.slice(at + query.length))
        );
      };

      els.searchContent.innerHTML = data.users.length
        ? data.users
            .map((user) => {
              const name = highlight(user.username);
              return `<div class="tg-search-result" data-peer="${user._id}" data-name="${escapeHtml(user.username)}" data-display="${escapeHtml(user.displayName || "")}">
                <div class="result-avatar">${escapeHtml(initialOf(user))}</div>
                <div class="result-info">
                  <div class="result-name">${user.displayName ? escapeHtml(user.displayName) : name}</div>
                  <div class="tg-result-handle">@${name}</div>
                </div>
              </div>`;
            })
            .join("")
        : '<div class="tg-search-empty"><span class="material-symbols-rounded">person_search</span><div>کاربری پیدا نشد</div></div>';
      els.searchOverlay.classList.add("show");
    } catch {
      toast("خطا در جستجو");
    }
  }, 300);

  // ----------------------------------------------------------- DOM events

  els.convContainer.addEventListener("click", (e) => {
    const item = e.target.closest("[data-peer]");
    if (item) openConversation(item.dataset.peer, item.dataset.name, item.dataset.display);
  });

  els.searchContent.addEventListener("click", (e) => {
    const item = e.target.closest("[data-peer]");
    if (!item) return;
    const { peer, name, display } = item.dataset;
    clearSearch();
    openConversation(peer, name, display);
  });

  els.searchInput.addEventListener("input", () => {
    els.searchClear.classList.toggle("show", !!els.searchInput.value);
    runSearch();
  });
  els.searchClear.addEventListener("click", clearSearch);
  els.searchInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    await runSearch.flush();
    els.searchContent.querySelector("[data-peer]")?.click();
  });

  $("chatBackBtn").addEventListener("click", closeChat);
  els.sendBtn.addEventListener("click", sendMessage);
  els.input.addEventListener("input", handleTyping);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !isTouch && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.replyCancel.addEventListener("click", cancelReply);
  els.scrollDown.addEventListener("click", goToLatest);
  els.pinnedUnpin.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = state.pinned[state.pinnedIndex];
    if (current) togglePin(current);
  });
  els.pinnedBar.addEventListener("click", () => {
    const current = state.pinned[state.pinnedIndex];
    if (!current) return;
    jumpTo(current._id);
    state.pinnedIndex = (state.pinnedIndex + 1) % state.pinned.length;
    renderPinned();
  });
  els.unblockBtn.addEventListener("click", async () => {
    if (!state.peer) return;
    try {
      await api("POST", `/users/${state.peer.id}/block`);
      state.peer.isBlockedByYou = false;
      renderBlockState();
      loadConversationsSoon();
    } catch (error) {
      toast(error.message);
    }
  });

  els.confirmDelete.addEventListener("click", confirmDelete);
  els.cancelDelete.addEventListener("click", closeDeleteModal);
  els.modal.addEventListener("click", (e) => {
    if (e.target === els.modal) closeDeleteModal();
  });

  $("logoutBtn").addEventListener("click", async () => {
    try {
      await api("POST", "/auth/logout");
    } catch {}
    sessionStorage.removeItem("accessToken");
    sessionStorage.removeItem("tokenExpiryTime");
    window.location.href = "/auth/login";
  });

  els.list.addEventListener("click", (e) => {
    const retryEl = e.target.closest("[data-retry]");
    if (retryEl) return retry(retryEl.closest(".tg-msg-wrap").dataset.id);

    const quote = e.target.closest("[data-jump]");
    if (quote) jumpTo(quote.dataset.jump);
  });

  els.list.addEventListener("contextmenu", (e) => {
    const wrap = e.target.closest(".tg-msg-wrap");
    if (!wrap || e.target.closest("a")) return;
    const message = findMessage(wrap.dataset.id);
    if (!message) return;
    e.preventDefault();
    openMenu(message, e.clientX, e.clientY);
  });

  els.menu.addEventListener("click", (e) => {
    const button = e.target.closest("[data-action]");
    const message = findMessage(els.menu.dataset.id);
    closeMenu();
    if (button && message) runMenuAction(button.dataset.action, message);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#contextMenu")) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (els.modal.classList.contains("active")) closeDeleteModal();
    else if (els.menu.classList.contains("show")) closeMenu();
    else if (state.reply) cancelReply();
  });
  window.addEventListener("resize", closeMenu);

  let scrollFrame = 0;
  els.list.addEventListener(
    "scroll",
    () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        closeMenu();
        if (els.list.scrollTop < 150) loadOlder();
        if (distanceFromBottom() < 400) loadNewer();
        if (isNearBottom()) {
          state.newCount = 0;
          markReadSoon();
        }
        updateScrollButton();
      });
    },
    { passive: true },
  );

  document.addEventListener("visibilitychange", () => {
    if (isVisible()) markReadSoon();
  });

  // Long press opens the menu and a swipe to the left starts a reply.
  let touch = null;
  els.list.addEventListener(
    "touchstart",
    (e) => {
      const wrap = e.target.closest(".tg-msg-wrap");
      if (!wrap || e.touches.length !== 1) return;
      const point = e.touches[0];
      touch = { wrap, x: point.clientX, y: point.clientY, dx: 0, swiping: false, pressed: false };
      touch.timer = setTimeout(() => {
        if (!touch || touch.swiping) return;
        touch.pressed = true;
        const message = findMessage(wrap.dataset.id);
        if (message) openMenu(message, touch.x, touch.y);
        if (navigator.vibrate) navigator.vibrate(10);
      }, 480);
    },
    { passive: true },
  );

  els.list.addEventListener(
    "touchmove",
    (e) => {
      if (!touch) return;
      const point = e.touches[0];
      const dx = point.clientX - touch.x;
      const dy = point.clientY - touch.y;

      if (!touch.swiping) {
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearTimeout(touch.timer);
        if (dx < -12 && Math.abs(dx) > Math.abs(dy)) touch.swiping = true;
        else if (Math.abs(dy) > 12) touch = null;
        if (!touch || !touch.swiping) return;
      }

      touch.dx = Math.max(dx, -80);
      const bubble = touch.wrap.querySelector(".tg-msg-bubble");
      const hint = touch.wrap.querySelector(".swipe-hint");
      bubble.style.transform = `translateX(${touch.dx}px)`;
      hint.style.opacity = String(Math.min(1, -touch.dx / 56));
    },
    { passive: true },
  );

  const endTouch = () => {
    if (!touch) return;
    clearTimeout(touch.timer);
    if (touch.swiping) {
      touch.wrap.querySelector(".tg-msg-bubble").style.transform = "";
      touch.wrap.querySelector(".swipe-hint").style.opacity = "0";
      if (touch.dx <= -56) {
        const message = findMessage(touch.wrap.dataset.id);
        if (message) startReply(message);
      }
    }
    touch = null;
  };
  els.list.addEventListener("touchend", endTouch, { passive: true });
  els.list.addEventListener("touchcancel", endTouch, { passive: true });

  // ---------------------------------------------------------- socket events

  socket.on("connect", () => {
    state.watched.clear();
    loadConversations();
    if (state.peer) watchPresence([state.peer.id]);

    if (state.connectedOnce && state.peer) syncMissed();
    state.connectedOnce = true;
  });

  // After a reconnect, fetch what arrived while the socket was away.
  async function syncMissed() {
    const after = lastRealId();
    const token = state.openToken;
    if (!after || state.hasMoreNewer) return;
    try {
      const data = await api("GET", `/messages/${state.peer.id}?limit=${PAGE_SIZE}&after=${after}`);
      if (token !== state.openToken) return;
      const stick = isNearBottom();
      data.messages.forEach(upsertMessage);
      state.hasMoreNewer = data.hasMoreNewer;
      renderMessages(stick ? "bottom" : "keep");
      markReadSoon();
    } catch {}
  }

  socket.on("message:new", (message) => {
    const peerId = senderOf(message);
    const inChat = state.peer?.id === peerId;

    if (inChat) {
      if (!state.hasMoreNewer && !findMessage(message._id)) {
        const stick = isNearBottom() && isVisible();
        upsertMessage(message);
        state.animateId = message._id;
        if (!stick) state.newCount += 1;
        trimIfLong();
        renderMessages(stick ? "bottom" : "keep");
      } else if (state.hasMoreNewer) {
        state.newCount += 1;
        updateScrollButton();
      }
      state.typing.delete(peerId);
      renderHeaderStatus();
      markReadSoon();
    } else {
      toast(`پیام جدید از ${labelOf(message.sender)}`, "success");
    }

    const readNow = inChat && isVisible() && isNearBottom();
    touchConversation(peerId, message.sender, message, {
      unreadDelta: readNow ? 0 : 1,
    });
  });

  // Own messages arriving from another tab or device.
  socket.on("message:sent", (message) => {
    const peerId = idOf(message.recipient);
    if (state.peer?.id === peerId && !findMessage(message._id)) {
      const waitingForResponse = state.messages.some(
        (m) => m.pending && m.content === message.content,
      );
      if (!waitingForResponse && !state.hasMoreNewer) {
        upsertMessage(message);
        renderMessages(isNearBottom() ? "bottom" : "keep");
      }
    }
    touchConversation(peerId, message.recipient, message);
  });

  socket.on("messages:read", ({ userId }) => {
    let changed = false;
    if (state.peer?.id === userId) {
      state.messages.forEach((m) => {
        if (isMine(m) && !m.isRead && !isPending(m)) {
          m.isRead = true;
          changed = true;
        }
      });
      if (changed) renderMessages("keep");
    }
    const conv = conversationOf(userId);
    if (conv?.lastMessage && conv.lastMessage.sender === ME.id) {
      conv.lastMessage.isRead = true;
      renderConversations();
    }
  });

  socket.on("message:read", ({ messageId }) => {
    const message = findMessage(messageId);
    if (message && !message.isRead) {
      message.isRead = true;
      renderMessages("keep");
    }
  });

  socket.on("message:deleted", ({ messageId }) => {
    removeMessage(messageId);
    loadConversationsSoon();
  });

  socket.on("message:deleted:self", ({ messageId }) => {
    removeMessage(messageId);
    loadConversationsSoon();
  });

  socket.on("message:pinned", applyPinEvent);

  socket.on("messages:unread_count", ({ count }) => {
    document.title = count > 0 ? `(${count}) پیام‌ها · واتی‌واتی` : "پیام‌ها · واتی‌واتی";
  });

  const typingTimers = new Map();
  socket.on("typing:start", ({ userId }) => {
    state.typing.add(userId);
    clearTimeout(typingTimers.get(userId));
    typingTimers.set(
      userId,
      setTimeout(() => {
        state.typing.delete(userId);
        renderHeaderStatus();
        renderConversations();
      }, 6000),
    );
    renderHeaderStatus();
    renderConversations();
  });
  socket.on("typing:stop", ({ userId }) => {
    state.typing.delete(userId);
    renderHeaderStatus();
    renderConversations();
  });

  socket.on("user:online", ({ userId }) => {
    state.online.add(userId);
    renderHeaderStatus();
    renderConversations();
  });
  socket.on("user:offline", ({ userId }) => {
    state.online.delete(userId);
    state.typing.delete(userId);
    renderHeaderStatus();
    renderConversations();
  });

  socket.on("user:blocked", ({ userId }) => {
    if (state.peer?.id === userId) {
      state.peer.isBlockedByThem = true;
      renderBlockState();
    }
    loadConversationsSoon();
  });
  socket.on("user:unblocked", ({ userId }) => {
    if (state.peer?.id === userId) {
      state.peer.isBlockedByThem = false;
      renderBlockState();
    }
    loadConversationsSoon();
  });

  // ------------------------------------------------------------------ init

  renderConversations();
  const preselected = document.body.dataset.preselected;
  if (preselected) {
    api("GET", `/users/${preselected}/info`)
      .then((data) =>
        openConversation(data.data.user._id, data.data.user.username, data.data.user.displayName),
      )
      .catch(() => {});
  }

  // Exposed for tests only.
  window.__chat = { state, renderMessages, openConversation };
})();
