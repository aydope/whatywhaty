const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { startServer, createClient, waitFor, sleep, SECRETS } = require("./helpers");

const MONGODB_URI =
  process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/whatywhaty_test";

let server;
let api;

before(async () => {
  await mongoose.connect(MONGODB_URI);
  await mongoose.connection.dropDatabase();
  server = await startServer({ port: 3200 });
  api = createClient(server.base);
});

after(async () => {
  await server?.stop();
  await mongoose.disconnect();
});

describe("authentication", () => {
  it("never returns the password reset token in the response", async () => {
    const user = await api.register("reset");
    const known = await api.request("POST", "/auth/forgot-password", {
      body: { email: user.email },
    });
    const unknown = await api.request("POST", "/auth/forgot-password", {
      body: { email: "nobody@example.com" },
    });

    assert.equal(known.status, 200);
    assert.equal(known.json.redirect, undefined);
    assert.doesNotMatch(known.text, /token=/);
    assert.deepEqual(known.json, unknown.json);
  });

  it("renews an expired access token from the refresh cookie", async () => {
    const user = await api.register("renew");
    const refresh = user.cookie.match(/refreshToken=[^;]+/)[0];
    const expired = jwt.sign({ userId: user.userId }, SECRETS.JWT_ACCESS_SECRET, {
      expiresIn: -60,
    });

    const res = await api.request("GET", "/", {
      cookie: `accessToken=${expired}; ${refresh}`,
      headers: { accept: "text/html" },
    });
    assert.equal(res.status, 200);
    assert.match(res.res.headers.getSetCookie().join(";"), /accessToken=/);
  });

  it("renews the session when the access cookie is missing entirely", async () => {
    const user = await api.register("nocookie");
    const refresh = user.cookie.match(/refreshToken=[^;]+/)[0];
    const res = await api.request("GET", "/", {
      cookie: refresh,
      headers: { accept: "text/html" },
    });
    assert.equal(res.status, 200);
  });

  it("rejects requests without a session", async () => {
    const json = await api.request("GET", "/messages/conversations");
    assert.equal(json.status, 401);
    const page = await api.request("GET", "/", { headers: { accept: "text/html" } });
    assert.equal(page.status, 302);
    assert.equal(page.res.headers.get("location"), "/auth/login");
  });

  it("revokes the access token on logout", async () => {
    const user = await api.register("logout");
    const out = await api.request("POST", "/auth/logout", { cookie: user.cookie });
    assert.equal(out.status, 200);

    const accessOnly = user.cookie.match(/accessToken=[^;]+/)[0];
    const after = await api.request("GET", "/messages/unread/count", { cookie: accessOnly });
    assert.equal(after.status, 401);

    const refreshOnly = user.cookie.match(/refreshToken=[^;]+/)[0];
    const retry = await api.request("GET", "/messages/unread/count", { cookie: refreshOnly });
    assert.equal(retry.status, 401);
  });

  it("keeps several devices signed in and signs them out on password change", async () => {
    const user = await api.register("multi");
    const login = await api.request("POST", "/auth/login", {
      body: { email: user.email, password: "Passw0rd!x" },
    });
    const second = login.res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    assert.equal((await api.request("GET", "/messages/unread/count", { cookie: user.cookie })).status, 200);
    assert.equal((await api.request("GET", "/messages/unread/count", { cookie: second })).status, 200);

    const change = await api.request("PUT", "/auth/change-password", {
      cookie: user.cookie,
      body: { currentPassword: "Passw0rd!x", newPassword: "N3wPassw0rd!" },
    });
    assert.equal(change.status, 200);

    const fresh = change.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    assert.equal((await api.request("GET", "/messages/unread/count", { cookie: fresh })).status, 200);
    assert.equal((await api.request("GET", "/messages/unread/count", { cookie: second })).status, 401);
    assert.equal((await api.request("GET", "/messages/unread/count", { cookie: user.cookie })).status, 401);
  });

  it("rate limits repeated login attempts", async () => {
    const ip = "203.0.113.50";
    let last;
    for (let i = 0; i < 11; i++) {
      last = await api.request("POST", "/auth/login", {
        ip,
        body: { email: "nobody@example.com", password: "wrong" },
      });
    }
    assert.equal(last.status, 429);
  });

  it("rejects state changing requests from a foreign origin", async () => {
    const user = await api.register("origin");
    const res = await api.request("POST", "/posts", {
      cookie: user.cookie,
      body: { content: "hello" },
      headers: { origin: "https://evil.example" },
    });
    assert.equal(res.status, 403);
  });

  it("keeps working when Redis is unreachable", async () => {
    const isolated = await startServer({
      port: 3201,
      env: { REDIS_URL: "redis://127.0.0.1:6399" },
    });
    try {
      const client = createClient(isolated.base);
      const user = await client.register("noredis");
      const home = await client.request("GET", "/", {
        cookie: user.cookie,
        headers: { accept: "text/html" },
      });
      assert.equal(home.status, 200);
      const login = await client.request("GET", "/auth/login", {
        cookie: user.cookie,
        headers: { accept: "text/html" },
      });
      assert.equal(login.status, 302);
      assert.equal(login.res.headers.get("location"), "/");
    } finally {
      await isolated.stop();
    }
  });
});

describe("profiles and social graph", () => {
  it("shows an email only on the owner's own profile", async () => {
    const alice = await api.register("alice");
    const bob = await api.register("bob");
    const html = { accept: "text/html" };

    const other = await api.request("GET", `/@${bob.username}`, { cookie: alice.cookie, headers: html });
    assert.equal(other.status, 200);
    assert.ok(!other.text.includes(bob.email));

    const own = await api.request("GET", `/@${bob.username}`, { cookie: bob.cookie, headers: html });
    assert.ok(own.text.includes(bob.email));

    const missing = await api.request("GET", "/@does_not_exist", { cookie: alice.cookie, headers: html });
    assert.equal(missing.status, 404);
  });

  it("does not let users follow or block themselves", async () => {
    const user = await api.register("self");
    assert.equal((await api.request("POST", `/users/${user.userId}/follow`, { cookie: user.cookie })).status, 400);
    assert.equal((await api.request("POST", `/users/${user.userId}/block`, { cookie: user.cookie })).status, 400);
    assert.equal((await api.request("POST", "/users/not-an-id/follow", { cookie: user.cookie })).status, 400);
  });

  it("toggles follow and paginates followers with numeric pages", async () => {
    const target = await api.register("target");
    const fans = await Promise.all([1, 2, 3].map(() => api.register("fan")));
    for (const fan of fans) {
      const res = await api.request("POST", `/users/${target.userId}/follow`, { cookie: fan.cookie });
      assert.equal(res.json.following, true);
    }
    const again = await api.request("POST", `/users/${target.userId}/follow`, { cookie: fans[0].cookie });
    assert.equal(again.json.following, false);
    assert.equal(again.json.followersCount, 2);

    const page = await api.request("GET", `/users/${target.userId}/followers?limit=1&page=1`, {
      cookie: target.cookie,
    });
    assert.equal(page.json.followers.length, 1);
    assert.equal(page.json.total, 2);
    assert.equal(page.json.nextPage, 2);
    assert.equal(page.json.followers[0].email, undefined);
  });

  it("rejects a taken username regardless of case", async () => {
    const first = await api.register("Casey");
    const second = await api.register("other");
    const res = await api.request("PUT", "/users/profile", {
      cookie: second.cookie,
      body: { username: first.username.toUpperCase() },
    });
    assert.equal(res.status, 400);
  });
});

describe("posts and comments", () => {
  it("keeps every concurrent like", async () => {
    const author = await api.register("author");
    const post = (await api.request("POST", "/posts", { cookie: author.cookie, body: { content: "post" } })).json.post;
    const voters = await Promise.all(Array.from({ length: 12 }, () => api.register("voter")));

    await Promise.all(
      voters.map((v) => api.request("POST", `/posts/${post._id}/like`, { cookie: v.cookie })),
    );

    const view = await api.request("GET", `/posts/${post._id}`, { cookie: voters[0].cookie });
    assert.equal(view.json.post.likesCount, 12);
    assert.deepEqual(view.json.post.likes.map(String), [voters[0].userId]);

    const anon = await api.request("GET", `/posts/${post._id}`);
    assert.equal(anon.json.post.likesCount, 12);
    assert.deepEqual(anon.json.post.likes, []);
  });

  it("serves explore pages with the viewer's like state", async () => {
    const user = await api.register("explorer");
    const post = (await api.request("POST", "/posts", { cookie: user.cookie, body: { content: "explore me" } })).json.post;
    await api.request("POST", `/posts/${post._id}/like`, { cookie: user.cookie });

    const res = await api.request("GET", "/posts/explore", { cookie: user.cookie });
    const found = res.json.posts.find((p) => p._id === post._id);
    assert.ok(found);
    assert.equal(found.likesCount, 1);
    assert.equal(found.likes.length, 1);

    const other = await api.register("explorer2");
    const otherView = await api.request("GET", "/posts/explore", { cookie: other.cookie });
    assert.equal(otherView.json.posts.find((p) => p._id === post._id).likes.length, 0);
  });

  it("limits reply depth and keeps replies inside their post", async () => {
    const user = await api.register("commenter");
    const [postA, postB] = await Promise.all(
      [1, 2].map(async () =>
        (await api.request("POST", "/posts", { cookie: user.cookie, body: { content: "p" } })).json.post,
      ),
    );

    let parent = null;
    for (let depth = 0; depth <= 5; depth++) {
      const res = await api.request("POST", "/comments", {
        cookie: user.cookie,
        body: { content: `c${depth}`, postId: postA._id, parentCommentId: parent?._id },
      });
      assert.equal(res.status, 201, `depth ${depth}`);
      parent = res.json.comment;
    }
    const tooDeep = await api.request("POST", "/comments", {
      cookie: user.cookie,
      body: { content: "x", postId: postA._id, parentCommentId: parent._id },
    });
    assert.equal(tooDeep.status, 400);

    const crossPost = await api.request("POST", "/comments", {
      cookie: user.cookie,
      body: { content: "x", postId: postB._id, parentCommentId: parent._id },
    });
    assert.equal(crossPost.status, 404);
  });

  it("keeps comment counts correct after deleting a comment tree", async () => {
    const user = await api.register("cleaner");
    const post = (await api.request("POST", "/posts", { cookie: user.cookie, body: { content: "p" } })).json.post;
    const root = (await api.request("POST", "/comments", { cookie: user.cookie, body: { content: "a", postId: post._id } })).json.comment;
    await api.request("POST", "/comments", { cookie: user.cookie, body: { content: "b", postId: post._id, parentCommentId: root._id } });
    await api.request("POST", "/comments", { cookie: user.cookie, body: { content: "keep", postId: post._id } });

    assert.equal((await api.request("DELETE", `/comments/${root._id}`, { cookie: user.cookie })).status, 200);

    const view = await api.request("GET", `/posts/${post._id}`, { cookie: user.cookie });
    assert.equal(view.json.post.commentsCount, 1);
    const list = await api.request("GET", `/comments/post/${post._id}`, { cookie: user.cookie });
    assert.equal(list.json.pagination.total, 1);
  });

  it("answers invalid ids with 4xx instead of crashing", async () => {
    const user = await api.register("badid");
    for (const url of ["/posts/zzz", "/comments/post/zzz", "/users/zzz/posts", "/messages/zzz"]) {
      const res = await api.request("GET", url, { cookie: user.cookie });
      assert.ok(res.status === 400 || res.status === 404, `${url} -> ${res.status}`);
    }
  });
});

describe("identity: display name, bio and @id", () => {
  const registerWith = async (extra) => {
    const username = `idn${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const res = await api.request("POST", "/auth/register", {
      body: { username, email: `${username}@example.com`, password: "Passw0rd!x", ...extra },
    });
    assert.equal(res.status, 201, res.text);
    const cookie = res.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const userId = jwt.decode(cookie.match(/accessToken=([^;]+)/)[1]).userId;
    return { username, cookie, userId };
  };

  it("stores a cleaned display name and rejects a too long one", async () => {
    const user = await registerWith({ displayName: "  علی \u202E  رضایی\u200B " });
    const doc = await mongoose.connection
      .collection("users")
      .findOne({ _id: new mongoose.Types.ObjectId(user.userId) });
    assert.equal(doc.displayName, "علی رضایی");

    const tooLong = await api.request("POST", "/auth/register", {
      body: { username: "longname1", email: "longname1@example.com", password: "Passw0rd!x", displayName: "x".repeat(51) },
    });
    assert.equal(tooLong.status, 400);
  });

  it("updates display name and bio, limits their length and escapes the bio", async () => {
    const user = await registerWith({});
    const ok = await api.request("PUT", "/users/profile", {
      cookie: user.cookie,
      body: { displayName: "Sara", bio: "line one\n\n\n\nline <script>alert(1)</script>" },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.displayName, "Sara");
    assert.equal(ok.json.user.bio, "line one\n\nline <script>alert(1)</script>");

    const longBio = await api.request("PUT", "/users/profile", {
      cookie: user.cookie,
      body: { bio: "x".repeat(161) },
    });
    assert.equal(longBio.status, 400);

    const viewer = await api.register("viewer");
    const page = await api.request("GET", `/@${user.username}`, {
      cookie: viewer.cookie,
      headers: { accept: "text/html" },
    });
    assert.match(page.text, /Sara/);
    assert.match(page.text, /&lt;script&gt;alert\(1\)/);
    assert.doesNotMatch(page.text, /<script>alert\(1\)<\/script>/);

    const cleared = await api.request("PUT", "/users/profile", { cookie: user.cookie, body: { bio: "" } });
    assert.equal(cleared.json.user.bio, "");
  });

  it("finds people by display name or @id and ranks the exact id first", async () => {
    const exact = await registerWith({ displayName: "Zed Person" });
    const similar = await api.request("POST", "/auth/register", {
      body: { username: `${exact.username}x`, email: `${exact.username}x@example.com`, password: "Passw0rd!x", displayName: "Other" },
    });
    assert.equal(similar.status, 201);
    const searcher = await api.register("searcher");

    const byId = await api.request("GET", `/users/search?q=${encodeURIComponent("@" + exact.username)}`, { cookie: searcher.cookie });
    assert.equal(byId.json.users[0].username, exact.username);
    assert.equal(byId.json.users[0].displayName, "Zed Person");
    assert.equal(byId.json.users[1].username, `${exact.username}x`);

    const byName = await api.request("GET", "/users/search?q=zed%20pers", { cookie: searcher.cookie });
    assert.equal(byName.json.users[0].username, exact.username);
  });

  it("sends and reads messages addressed by @username, ignoring case", async () => {
    const alice = await registerWith({ displayName: "Alice A" });
    const bob = await registerWith({ displayName: "Bob B" });

    const sent = await api.request("POST", `/messages/@${bob.username.toUpperCase()}`, {
      cookie: alice.cookie,
      body: { content: "hi by id" },
    });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.json.message.recipient._id, bob.userId);
    assert.equal(sent.json.message.sender.displayName, "Alice A");

    const history = await api.request("GET", `/messages/@${alice.username}`, { cookie: bob.cookie });
    assert.equal(history.json.messages[0].content, "hi by id");
    assert.equal(history.json.recipient.displayName, "Alice A");

    const missing = await api.request("POST", "/messages/@nobodyhere", { cookie: alice.cookie, body: { content: "x" } });
    assert.equal(missing.status, 404);
    const junk = await api.request("POST", "/messages/@a$b", { cookie: alice.cookie, body: { content: "x" } });
    assert.equal(junk.status, 404);

    const list = await api.request("GET", "/messages/conversations", { cookie: bob.cookie });
    assert.equal(list.json.conversations[0].user.displayName, "Alice A");

    for (const url of [`/messages/@${bob.username}`, `/messages?user=@${bob.username}`]) {
      const page = await api.request("GET", url, { cookie: alice.cookie, headers: { accept: "text/html" } });
      assert.equal(page.status, 200, url);
      assert.match(page.text, new RegExp(`data-preselected="${bob.userId}"`), url);
    }
  });

  it("shows the display name on posts and resolves profiles case-insensitively", async () => {
    const author = await registerWith({ displayName: "Poster P" });
    const post = (await api.request("POST", "/posts", { cookie: author.cookie, body: { content: "named" } })).json.post;
    assert.equal(post.author.displayName, "Poster P");

    const reader = await api.register("reader");
    const view = await api.request("GET", `/posts/${post._id}`, { cookie: reader.cookie });
    assert.equal(view.json.post.author.displayName, "Poster P");

    const page = await api.request("GET", `/@${author.username.toUpperCase()}`, { cookie: reader.cookie, headers: { accept: "text/html" } });
    assert.equal(page.status, 200);
    assert.match(page.text, /Poster P/);
  });
});

describe("pages", () => {
  it("render for a signed in user and for an admin", async () => {
    const user = await api.register("pages");
    const other = await api.register("pagesother");
    const post = (await api.request("POST", "/posts", { cookie: user.cookie, body: { content: "page post" } })).json.post;
    await api.request("POST", "/comments", { cookie: other.cookie, body: { content: "nice", postId: post._id } });
    await api.request("POST", `/posts/${post._id}/like`, { cookie: other.cookie });

    const html = { accept: "text/html" };
    for (const url of ["/", "/explore", `/@${user.username}`, `/@${other.username}`, `/posts/${post._id}`, "/messages", `/messages?user=${other.userId}`]) {
      const res = await api.request("GET", url, { cookie: user.cookie, headers: html });
      assert.equal(res.status, 200, `${url} -> ${res.status}`);
      assert.match(res.text, /<html/i, url);
    }

    const postPage = await api.request("GET", `/posts/${post._id}`, { cookie: other.cookie, headers: html });
    assert.match(postPage.text, /nice/);

    await mongoose.connection.collection("users").updateOne(
      { _id: new mongoose.Types.ObjectId(user.userId) },
      { $set: { role: "admin" } },
    );
    for (const url of ["/admin/dashboard", "/admin/users", "/admin/posts", "/admin/comments"]) {
      const res = await api.request("GET", url, { cookie: user.cookie, headers: html });
      assert.equal(res.status, 200, `${url} -> ${res.status}`);
      assert.doesNotMatch(res.text, /ReferenceError|TypeError/, url);
    }
    assert.equal((await api.request("GET", "/nope", { cookie: user.cookie, headers: html })).status, 404);
  });
});

describe("admin", () => {
  it("answers anonymous and non-admin requests exactly once", async () => {
    const anon = await api.request("GET", "/admin/users");
    assert.equal(anon.status, 401);
    const user = await api.register("plain");
    const forbidden = await api.request("GET", "/admin/users", { cookie: user.cookie });
    assert.equal(forbidden.status, 403);
    assert.doesNotMatch(server.output(), /ALREADY_SENT|already sent/i);
  });

  it("removes everything that belongs to a deleted user", async () => {
    const admin = await api.register("admin");
    await mongoose.connection.collection("users").updateOne(
      { _id: new mongoose.Types.ObjectId(admin.userId) },
      { $set: { role: "admin" } },
    );
    const victim = await api.register("victim");
    const friend = await api.register("friend");

    await api.request("POST", `/users/${victim.userId}/follow`, { cookie: friend.cookie });
    const post = (await api.request("POST", "/posts", { cookie: friend.cookie, body: { content: "p" } })).json.post;
    await api.request("POST", `/posts/${post._id}/like`, { cookie: victim.cookie });
    const comment = (await api.request("POST", "/comments", { cookie: victim.cookie, body: { content: "c", postId: post._id } })).json.comment;
    await api.request("POST", `/messages/${friend.userId}`, { cookie: victim.cookie, body: { content: "hi" } });

    const res = await api.request("DELETE", `/admin/users/${victim.userId}`, { cookie: admin.cookie });
    assert.equal(res.status, 200);

    const view = await api.request("GET", `/posts/${post._id}`, { cookie: friend.cookie });
    assert.equal(view.json.post.likesCount, 0);
    assert.equal(view.json.post.commentsCount, 0);
    assert.equal(await mongoose.connection.collection("comments").countDocuments({ _id: new mongoose.Types.ObjectId(comment._id) }), 0);
    const victimId = new mongoose.Types.ObjectId(victim.userId);
    assert.equal(
      await mongoose.connection
        .collection("messages")
        .countDocuments({ $or: [{ sender: victimId }, { recipient: victimId }] }),
      0,
    );
    const friendDoc = await mongoose.connection.collection("users").findOne({ _id: new mongoose.Types.ObjectId(friend.userId) });
    assert.equal(friendDoc.following.length, 0);
  });
});

describe("messages", () => {
  let alice;
  let bob;
  let aliceSocket;
  let bobSocket;

  before(async () => {
    alice = await api.register("alice");
    bob = await api.register("bob");
    aliceSocket = await api.connectSocket(alice.cookie);
    bobSocket = await api.connectSocket(bob.cookie);
  });

  after(() => {
    aliceSocket.close();
    bobSocket.close();
  });

  const send = (from, toId, body) =>
    api.request("POST", `/messages/${toId}`, { cookie: from.cookie, body });

  it("delivers a message in real time and counts it as unread", async () => {
    const incoming = waitFor(bobSocket, "message:new");
    const res = await send(alice, bob.userId, { content: "  hello bob  " });
    assert.equal(res.status, 200);
    assert.equal(res.json.message.content, "hello bob");
    assert.equal(res.json.message.isRead, false);

    const delivered = await incoming;
    assert.equal(delivered._id, res.json.message._id);
    assert.equal(delivered.sender.username, alice.username);

    const unread = await api.request("GET", "/messages/unread/count", { cookie: bob.cookie });
    assert.equal(unread.json.count, 1);
    const list = await api.request("GET", "/messages/conversations", { cookie: bob.cookie });
    assert.equal(list.json.conversations[0].unreadCount, 1);
    assert.equal(list.json.conversations[0].user.isOnline, true);
  });

  it("flips messages to read for the sender when the recipient reads them", async () => {
    const readEvent = waitFor(aliceSocket, "messages:read");
    const res = await api.request("PUT", `/messages/${alice.userId}/read-all`, { cookie: bob.cookie });
    assert.equal(res.status, 200);
    const event = await readEvent;
    assert.equal(event.userId, bob.userId);

    const history = await api.request("GET", `/messages/${bob.userId}`, { cookie: alice.cookie });
    assert.equal(history.json.messages[0].isRead, true);
    assert.ok(history.json.messages[0].readAt);
    const unread = await api.request("GET", "/messages/unread/count", { cookie: bob.cookie });
    assert.equal(unread.json.count, 0);
  });

  it("marks messages read through the socket too", async () => {
    await send(alice, bob.userId, { content: "second" });
    await sleep(100);
    const readEvent = waitFor(aliceSocket, "messages:read");
    bobSocket.emit("message:read", { userId: alice.userId });
    await readEvent;
    const unread = await api.request("GET", "/messages/unread/count", { cookie: bob.cookie });
    assert.equal(unread.json.count, 0);
  });

  it("supports replies and hides a reply's original once it is deleted", async () => {
    const original = (await send(alice, bob.userId, { content: "question?" })).json.message;
    const reply = await send(bob, alice.userId, { content: "answer", replyTo: original._id });
    assert.equal(reply.json.message.replyTo.content, "question?");
    assert.equal(reply.json.message.replyTo.deleted, false);

    const foreign = await send(bob, alice.userId, { content: "x", replyTo: "000000000000000000000000" });
    assert.equal(foreign.status, 404);

    const del = await api.request("DELETE", `/messages/${original._id}`, {
      cookie: alice.cookie,
      body: { forBoth: true },
    });
    assert.equal(del.status, 200);

    const history = await api.request("GET", `/messages/${alice.userId}`, { cookie: bob.cookie });
    const stored = history.json.messages.find((m) => m._id === reply.json.message._id);
    assert.equal(stored.replyTo.deleted, true);
    assert.ok(!history.json.messages.some((m) => m._id === original._id));
  });

  it("pins and unpins for both participants", async () => {
    const message = (await send(alice, bob.userId, { content: "important" })).json.message;
    const bobSees = waitFor(bobSocket, "message:pinned");
    const pin = await api.request("PUT", `/messages/${message._id}/pin`, {
      cookie: alice.cookie,
      body: { pinned: true },
    });
    assert.equal(pin.status, 200);
    const event = await bobSees;
    assert.equal(event.messageId, message._id);
    assert.equal(event.pinned, true);
    assert.equal(event.peerId, alice.userId);

    const history = await api.request("GET", `/messages/${alice.userId}`, { cookie: bob.cookie });
    assert.deepEqual(history.json.pinned.map((m) => m._id), [message._id]);

    await api.request("PUT", `/messages/${message._id}/pin`, { cookie: bob.cookie, body: { pinned: false } });
    const after = await api.request("GET", `/messages/${alice.userId}`, { cookie: alice.cookie });
    assert.equal(after.json.pinned.length, 0);

    const outsider = await api.register("outsider");
    const denied = await api.request("PUT", `/messages/${message._id}/pin`, { cookie: outsider.cookie, body: { pinned: true } });
    assert.equal(denied.status, 403);
  });

  it("deletes for one side only, or for both", async () => {
    const mine = (await send(alice, bob.userId, { content: "only me" })).json.message;
    const selfEvent = waitFor(aliceSocket, "message:deleted:self");
    const res = await api.request("DELETE", `/messages/${mine._id}`, { cookie: alice.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.forBoth, false);
    assert.equal((await selfEvent).forBoth, false);

    const aliceView = await api.request("GET", `/messages/${bob.userId}`, { cookie: alice.cookie });
    const bobView = await api.request("GET", `/messages/${alice.userId}`, { cookie: bob.cookie });
    assert.ok(!aliceView.json.messages.some((m) => m._id === mine._id));
    assert.ok(bobView.json.messages.some((m) => m._id === mine._id));

    const bothEvent = waitFor(aliceSocket, "message:deleted");
    const theirs = (await send(bob, alice.userId, { content: "remove for all" })).json.message;
    await api.request("DELETE", `/messages/${theirs._id}`, { cookie: bob.cookie, body: { forBoth: true } });
    const event = await bothEvent;
    assert.equal(event.messageId, theirs._id);
    assert.equal(event.forBoth, true);

    const gone = await api.request("GET", `/messages/${bob.userId}`, { cookie: alice.cookie });
    assert.ok(!gone.json.messages.some((m) => m._id === theirs._id));

    const secondDelete = await api.request("DELETE", `/messages/${mine._id}`, { cookie: alice.cookie });
    assert.equal(secondDelete.status, 404);
  });

  it("hides messages deleted for me from the conversation list and unread count", async () => {
    const carol = await api.register("carol");
    const dave = await api.register("dave");
    const sent = (await send(carol, dave.userId, { content: "hidden" })).json.message;
    await api.request("DELETE", `/messages/${sent._id}`, { cookie: dave.cookie });

    const list = await api.request("GET", "/messages/conversations", { cookie: dave.cookie });
    assert.equal(list.json.conversations.length, 0);
    const unread = await api.request("GET", "/messages/unread/count", { cookie: dave.cookie });
    assert.equal(unread.json.count, 0);
  });

  it("pages through history with cursors and jumps around a message", async () => {
    const erin = await api.register("erin");
    const frank = await api.register("frank");
    const ids = [];
    for (let i = 0; i < 35; i++) {
      ids.push((await send(erin, frank.userId, { content: `m${i}` })).json.message._id);
    }

    const latest = await api.request("GET", `/messages/${frank.userId}?limit=30`, { cookie: erin.cookie });
    assert.equal(latest.json.messages.length, 30);
    assert.equal(latest.json.messages.at(-1)._id, ids[34]);
    assert.equal(latest.json.hasMoreOlder, true);
    assert.equal(latest.json.hasMoreNewer, false);

    const older = await api.request(
      "GET",
      `/messages/${frank.userId}?limit=30&before=${latest.json.messages[0]._id}`,
      { cookie: erin.cookie },
    );
    assert.equal(older.json.messages.length, 5);
    assert.equal(older.json.hasMoreOlder, false);

    const around = await api.request("GET", `/messages/${frank.userId}?limit=10&around=${ids[10]}`, { cookie: erin.cookie });
    assert.ok(around.json.messages.some((m) => m._id === ids[10]));
    assert.equal(around.json.hasMoreNewer, true);
    assert.equal(around.json.hasMoreOlder, true);

    const newer = await api.request("GET", `/messages/${frank.userId}?limit=10&after=${ids[30]}`, { cookie: erin.cookie });
    assert.deepEqual(newer.json.messages.map((m) => m._id), ids.slice(31));
  });

  it("enforces blocks in both directions and rejects bad input", async () => {
    const gina = await api.register("gina");
    const hank = await api.register("hank");

    await api.request("POST", `/users/${hank.userId}/block`, { cookie: gina.cookie });
    const blockedByYou = await send(gina, hank.userId, { content: "hi" });
    assert.equal(blockedByYou.status, 403);
    assert.match(blockedByYou.json.message, /بلاک کرده/);

    const blockedByThem = await send(hank, gina.userId, { content: "hi" });
    assert.equal(blockedByThem.status, 403);
    assert.match(blockedByThem.json.message, /بلاک شده/);
    const history = await api.request("GET", `/messages/${gina.userId}`, { cookie: hank.cookie });
    assert.equal(history.status, 403);

    const flags = await api.request("GET", `/messages/${hank.userId}`, { cookie: gina.cookie });
    assert.equal(flags.json.recipient.isBlockedByYou, true);

    assert.equal((await send(gina, gina.userId, { content: "me" })).status, 400);
    assert.equal((await send(alice, bob.userId, { content: { $gt: "" } })).status, 400);
    assert.equal((await send(alice, bob.userId, { content: "x".repeat(1001) })).status, 400);
    assert.equal((await send(alice, bob.userId, { content: "   " })).status, 400);
    assert.equal((await send(alice, bob.userId, {})).status, 400);
  });

  it("sends through the socket with an acknowledgement", async () => {
    const incoming = waitFor(bobSocket, "message:new");
    const ack = await new Promise((resolve) =>
      aliceSocket.emit("message:send", { recipientId: bob.userId, content: "via socket" }, resolve),
    );
    assert.equal(ack.success, true);
    assert.equal((await incoming).content, "via socket");

    const bad = await new Promise((resolve) =>
      aliceSocket.emit("message:send", { recipientId: "nope", content: "x" }, resolve),
    );
    assert.equal(bad.success, false);
  });

  it("relays typing and presence only to the right people", async () => {
    const typing = waitFor(bobSocket, "typing:start");
    aliceSocket.emit("typing:start", { recipientId: bob.userId });
    assert.equal((await typing).userId, alice.userId);

    const state = await new Promise((resolve) =>
      bobSocket.emit("presence:watch", { userIds: [alice.userId, "bad"] }, resolve),
    );
    assert.deepEqual(state.online, [alice.userId]);

    const offline = waitFor(bobSocket, "user:offline");
    const temp = await api.connectSocket(alice.cookie);
    temp.close();
    await sleep(200);
    // Alice still has another socket open, so she must not be reported offline.
    await assert.rejects(waitFor(bobSocket, "user:offline", 400));
    offline.catch(() => {});
  });
});

describe("socket robustness", () => {
  it("survives malformed payloads from guests and users", async () => {
    const user = await api.register("fuzz");
    const guest = await api.connectSocket(null);
    const authed = await api.connectSocket(user.cookie);

    for (const socket of [guest, authed]) {
      for (const event of [
        "post:join", "post:leave", "typing:start", "typing:stop", "message:send",
        "message:read", "presence:watch", "presence:unwatch", "post:like",
        "comment:like", "user:active", "notification:read",
      ]) {
        socket.emit(event);
        socket.emit(event, null);
        socket.emit(event, 42);
        socket.emit(event, "text");
        socket.emit(event, [1, 2]);
        socket.emit(event, { recipientId: {}, userId: [], postId: {}, commentId: 5, userIds: "x", content: {} });
      }
    }
    await sleep(500);
    assert.equal(await server.isAlive(), true);
    assert.equal(guest.connected && authed.connected, true);
    guest.close();
    authed.close();
  });

  it("does not authenticate guests for private events", async () => {
    const guest = await api.connectSocket(null);
    const ack = await new Promise((resolve) =>
      guest.emit("message:send", { recipientId: "000000000000000000000000", content: "x" }, resolve),
    );
    assert.equal(ack.success, false);
    guest.close();
  });

  it("authenticates a socket from cookies alone, even with an expired access token", async () => {
    const user = await api.register("cookiesock");
    const refresh = user.cookie.match(/refreshToken=[^;]+/)[0];
    const expired = jwt.sign({ userId: user.userId }, SECRETS.JWT_ACCESS_SECRET, { expiresIn: -60 });
    const socket = await api.connectSocket(`accessToken=${expired}; ${refresh}`, {
      transports: ["polling"],
      useCookieOnly: true,
    });
    const ack = await new Promise((resolve) => socket.emit("presence:watch", { userIds: [] }, resolve));
    assert.equal(ack.success, true);
    socket.close();
  });
});
