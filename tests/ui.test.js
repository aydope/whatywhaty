const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { JSDOM } = require("jsdom");
const { io } = require("socket.io-client");
const { startServer, createClient, sleep } = require("./helpers");

const MONGODB_URI =
  process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/whatywhaty_test";
const SCRIPT = fs.readFileSync(path.join(__dirname, "../public/js/messages.js"), "utf8");

let server;
let api;

// Opens the real chat page for a user inside jsdom, wired to the real server
// through real HTTP requests and a real Socket.IO connection.
const openPage = async (user, query = "") => {
  const res = await fetch(`${server.base}/messages${query}`, {
    headers: { cookie: user.cookie, accept: "text/html", "x-forwarded-for": "10.9.9.9" },
  });
  assert.equal(res.status, 200);
  const html = await res.text();

  const dom = new JSDOM(html, { url: `${server.base}/messages${query}`, pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  const token = user.cookie.match(/accessToken=([^;]+)/)[1];

  window.CSS = { escape: (v) => String(v) };
  window.matchMedia = () => ({ matches: false });
  window.Element.prototype.scrollIntoView = () => {};
  window.Element.prototype.scrollTo = () => {};
  window.fetch = (url, options = {}) =>
    fetch(new URL(url, server.base), {
      ...options,
      headers: { ...options.headers, cookie: user.cookie, "x-forwarded-for": "10.9.9.9" },
    });
  const socket = io(server.base, { transports: ["websocket"], auth: { token }, reconnection: false });
  window.io = () => socket;

  window.eval(SCRIPT);
  await new Promise((resolve) => socket.on("connect", resolve));
  await sleep(150);

  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  return {
    window,
    $,
    $$,
    click,
    socket,
    bubbles: () => $$("#messagesContainer .tg-msg-wrap"),
    texts: () => $$("#messagesContainer .tg-msg-text").map((n) => n.textContent),
    openChat: async (peer) => {
      await window.__chat.openConversation(peer.userId, peer.username);
      await sleep(250);
    },
    type: (text) => {
      const input = $("#messageText");
      input.value = text;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    send: async (text) => {
      const input = $("#messageText");
      input.value = text;
      click($("#sendBtn"));
      await sleep(350);
    },
    menuFor: (wrap, action) => {
      wrap.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
      click($(`#contextMenu [data-action="${action}"]`));
    },
    close: () => {
      socket.close();
      window.close();
    },
  };
};

before(async () => {
  await mongoose.connect(MONGODB_URI);
  await mongoose.connection.dropDatabase();
  server = await startServer({ port: 3202 });
  api = createClient(server.base);
});

after(async () => {
  await server?.stop();
  await mongoose.disconnect();
});

describe("chat page", () => {
  let alice;
  let bob;
  let a;
  let b;

  before(async () => {
    alice = await api.register("alice");
    bob = await api.register("bob");
    a = await openPage(alice);
    b = await openPage(bob);
  });

  after(() => {
    a.close();
    b.close();
  });

  it("sends a message with an optimistic bubble and delivers it live", async () => {
    await a.openChat(bob);
    assert.match(a.$("#chatUsername").textContent, new RegExp(bob.username));

    await a.send("سلام بابک");
    assert.deepEqual(a.texts(), ["سلام بابک"]);
    const mine = a.bubbles()[0];
    assert.ok(mine.classList.contains("sent"));
    assert.equal(mine.querySelector(".tg-tick").textContent, "done");

    await sleep(200);
    const item = b.$(`.tg-conv-item[data-peer="${alice.userId}"]`);
    assert.ok(item, "bob sees the conversation");
    assert.equal(item.querySelector(".tg-unread-badge").textContent, "1");
  });

  it("shows double ticks once the other side opens the chat", async () => {
    await b.openChat(alice);
    assert.deepEqual(b.texts(), ["سلام بابک"]);
    assert.ok(b.bubbles()[0].classList.contains("received"));
    await sleep(300);

    const tick = a.bubbles()[0].querySelector(".tg-tick");
    assert.equal(tick.textContent, "done_all");
    assert.ok(a.bubbles()[0].classList.contains("is-read"));
    assert.equal(b.$(`.tg-conv-item[data-peer="${alice.userId}"] .tg-unread-badge`), null);
  });

  it("replies to a message and shows the quote on both sides", async () => {
    b.menuFor(b.bubbles()[0], "reply");
    assert.equal(b.$("#replyBar").hidden, false);
    assert.equal(b.$("#replyText").textContent, "سلام بابک");

    await b.send("سلام علی");
    assert.equal(b.$("#replyBar").hidden, true);
    await sleep(200);

    const quote = a.$("#messagesContainer .tg-reply-quote");
    assert.ok(quote);
    assert.match(quote.textContent, /سلام بابک/);
    assert.match(quote.textContent, /شما/);
    assert.equal(a.texts().at(-1), "سلام علی");
  });

  it("pins a message for both people and unpins it from the bar", async () => {
    a.menuFor(a.bubbles()[0], "pin");
    await sleep(300);
    for (const page of [a, b]) {
      assert.equal(page.$("#pinnedBar").hidden, false);
      assert.equal(page.$("#pinnedText").textContent, "سلام بابک");
      assert.ok(page.$$("#messagesContainer .tg-msg-meta").some((m) => m.textContent.includes("keep")));
    }

    b.click(b.$("#pinnedUnpinBtn"));
    await sleep(300);
    assert.equal(a.$("#pinnedBar").hidden, true);
    assert.equal(b.$("#pinnedBar").hidden, true);
  });

  it("deletes for both when asked and only for me otherwise", async () => {
    await a.send("temporary");
    await sleep(200);
    const target = a.bubbles().at(-1);

    a.menuFor(target, "delete");
    assert.ok(a.$("#confirmDeleteModal").classList.contains("active"));
    assert.match(a.$("#forBothLabel").textContent, new RegExp(bob.username));
    a.$("#forBothCheckbox").checked = true;
    a.click(a.$("#confirmDeleteBtn"));
    await sleep(350);
    assert.ok(!a.texts().includes("temporary"));
    assert.ok(!b.texts().includes("temporary"));

    await a.send("only mine");
    await sleep(200);
    a.menuFor(a.bubbles().at(-1), "delete");
    a.click(a.$("#confirmDeleteBtn"));
    await sleep(350);
    assert.ok(!a.texts().includes("only mine"));
    assert.ok(b.texts().includes("only mine"));
  });

  it("escapes message text and only links http(s) addresses", async () => {
    await a.send('<img src=x onerror="window.pwned=1"> https://example.com/a?b=1&c=2 javascript:alert(1)');
    await sleep(250);

    for (const page of [a, b]) {
      const last = page.$$("#messagesContainer .tg-msg-text").at(-1);
      assert.equal(last.querySelector("img"), null);
      assert.equal(page.window.pwned, undefined);
      const links = [...last.querySelectorAll("a")];
      assert.equal(links.length, 1);
      assert.equal(links[0].getAttribute("href"), "https://example.com/a?b=1&c=2");
      assert.match(links[0].getAttribute("rel"), /noopener/);
      assert.match(last.textContent, /<img src=x/);
    }
  });

  it("keeps the failed bubble and retries when sending fails", async () => {
    const realFetch = a.window.fetch;
    a.window.fetch = () => Promise.reject(new Error("offline"));
    await a.send("will fail");
    const failed = a.bubbles().at(-1);
    assert.ok(failed.classList.contains("failed"));
    assert.equal(failed.querySelector(".tg-tick").textContent, "error");

    a.window.fetch = realFetch;
    a.click(failed.querySelector("[data-retry]"));
    await sleep(400);
    assert.ok(!a.bubbles().at(-1).classList.contains("failed"));
    assert.ok(b.texts().includes("will fail"));
  });

  it("searches users and opens a new conversation", async () => {
    const carol = await api.register("carol");
    a.$("#searchUserInput").value = carol.username.slice(0, 6);
    a.$("#searchUserInput").dispatchEvent(new a.window.Event("input", { bubbles: true }));
    await sleep(700);

    const result = a.$(".tg-search-result");
    assert.ok(result);
    a.click(result);
    await sleep(300);
    assert.equal(a.$("#chatUsername").textContent, carol.username);
    assert.match(a.$("#messagesContainer").textContent, /هنوز پیامی/);
  });

  it("opens straight into a chat from the ?user= link", async () => {
    const dave = await api.register("dave");
    const page = await openPage(alice, `?user=${dave.userId}`);
    await sleep(400);
    assert.equal(page.$("#chatUsername").textContent, dave.username);
    page.close();
  });

  it("shows display names and opens a chat from an @id typed in the search box", async () => {
    const username = `named${Date.now().toString(36)}`;
    const res = await api.request("POST", "/auth/register", {
      body: { username, email: `${username}@example.com`, password: "Passw0rd!x", displayName: "سارا محمدی" },
    });
    assert.equal(res.status, 201);

    a.$("#searchUserInput").value = `@${username}`;
    a.$("#searchUserInput").dispatchEvent(new a.window.Event("input", { bubbles: true }));
    a.$("#searchUserInput").dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(900);

    assert.equal(a.$("#chatUsername").textContent, "سارا محمدی");
    assert.equal(a.$("#chatHandle").textContent, `@${username}`);
    assert.equal(a.$("#avatarLetter").textContent, "س");

    await a.send("hello sara");
    await sleep(300);
    const item = a.$(`.tg-conv-item[data-name="${username}"]`);
    assert.ok(item);
    assert.match(item.querySelector(".tg-conv-name").textContent, /سارا محمدی/);
  });

  it("hides the input when the other user blocked you", async () => {
    const erin = await api.register("erin");
    await api.request("POST", `/users/${alice.userId}/block`, { cookie: erin.cookie });
    await a.openChat(erin);
    assert.equal(a.$("#blockedNotice").style.display, "flex");
    assert.equal(a.$("#messageInputArea").style.display, "none");
  });
});
