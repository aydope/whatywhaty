const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SCRIPT = fs.readFileSync(path.join(__dirname, "../public/js/social.js"), "utf8");

const load = () => {
  const dom = new JSDOM('<body><div id="card" class="post-card"><button class="post-action-btn">like</button><p id="text">hi</p></div></body>', {
    url: "http://localhost/",
    runScripts: "outside-only",
  });
  dom.window.eval(SCRIPT);
  return dom.window;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("social helpers", () => {
  it("shows the display name with the @id and falls back to the id", () => {
    const w = load();
    const named = w.Social.postHeaderHtml(
      { author: { username: "sara1", displayName: "سارا" } },
      "۵ دقیقه پیش",
    );
    assert.match(named, />سارا</);
    assert.match(named, />@sara1</);
    assert.match(named, /avatar-ring/);

    const plain = w.Social.postHeaderHtml({ author: { username: "sara1" } }, "now");
    assert.match(plain, /post-username[^>]*>sara1</);
  });

  it("escapes names so they cannot inject markup", () => {
    const w = load();
    const html = w.Social.postHeaderHtml(
      { author: { username: "evil", displayName: '<img src=x onerror="alert(1)">' } },
      "now",
    );
    const doc = new JSDOM(`<body>${html}</body>`).window.document;
    assert.equal(doc.querySelector("img"), null);
    assert.match(doc.querySelector(".post-username").textContent, /<img src=x/);
  });

  it("takes the first whole character of the name for the avatar, emoji included", () => {
    const w = load();
    assert.equal(w.Social.initialOf("😀 Ali"), "😀");
    assert.equal(w.Social.initialOf("ali"), "A");
    assert.equal(w.Social.initialOf(""), "?");
  });

  it("opens the post on a single click and likes it on a double click", async () => {
    const w = load();
    const card = w.document.getElementById("card");
    let likes = 0;
    card.querySelector("button").addEventListener("click", () => likes++);

    let navigated = null;
    w.Social.navigate = (url) => {
      navigated = url;
    };
    w.Social.bindCard(card, "p1");

    const text = w.document.getElementById("text");
    text.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    text.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    text.dispatchEvent(new w.MouseEvent("dblclick", { bubbles: true }));
    await sleep(350);
    assert.equal(likes, 1);
    assert.equal(navigated, null);
    assert.ok(card.querySelector(".heart-burst"));

    text.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await sleep(350);
    assert.equal(navigated, "/posts/p1");

    // An already liked post is not unliked by a double click.
    card.querySelector("button").classList.add("liked");
    text.dispatchEvent(new w.MouseEvent("dblclick", { bubbles: true }));
    assert.equal(likes, 1);
  });
});
