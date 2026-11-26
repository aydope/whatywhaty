const Joi = require("joi");
const User = require("../models/User");
const { isObjectId, sameId } = require("../utils/ids");
const messages = require("../services/messageService");

const sendSchema = Joi.object({
  content: Joi.string().trim().min(1).max(1000).required().messages({
    "string.base": "متن پیام نامعتبر است",
    "string.empty": "متن پیام نمی‌تواند خالی باشد",
    "string.max": "پیام نمی‌تواند بیشتر از 1000 کاراکتر باشد",
    "any.required": "متن پیام نمی‌تواند خالی باشد",
  }),
  replyTo: Joi.string().hex().length(24).allow(null, ""),
});

const pageQuerySchema = Joi.object({
  before: Joi.string().hex().length(24),
  after: Joi.string().hex().length(24),
  around: Joi.string().hex().length(24),
  limit: Joi.number().integer().min(1).max(50).default(30),
}).oxor("before", "after", "around");

const rateLimit = (max, timeWindow) => ({
  config: { rateLimit: { max, timeWindow } },
});

// A conversation can be addressed by user id or by "@username".
const resolvePeerId = async (param) => {
  if (isObjectId(param)) return param;

  const name = param.replace(/^@/, "");
  if (!/^[A-Za-z0-9]{3,30}$/.test(name)) return null;

  const user = await User.findOne({ username: name })
    .collation({ locale: "en", strength: 2 })
    .select("_id")
    .lean();
  return user ? user._id.toString() : null;
};

module.exports = async function (fastify) {
  const auth = { preHandler: [fastify.authenticate] };

  const fail = (req, reply, error, fallback) => {
    if (error.statusCode && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send({ success: false, message: error.message });
    }
    req.log.error({ err: error }, fallback);
    return reply.status(500).send({ success: false, message: fallback });
  };

  const requireObjectId = (reply, id) => {
    if (isObjectId(id)) return true;
    reply
      .status(400)
      .send({ success: false, message: "شناسه نامعتبر است" });
    return false;
  };

  const renderChat = async (req, reply, target) =>
    reply.view("messages.ejs", {
      user: req.user,
      preselectedUser: (target && (await resolvePeerId(target))) || "",
      title: "پیام‌ها",
    });

  fastify.get("/", auth, (req, reply) =>
    renderChat(req, reply, typeof req.query.user === "string" ? req.query.user : ""),
  );


  fastify.get("/conversations", auth, async (req, reply) => {
    try {
      const conversations = await messages.listConversations(fastify, req.user);
      return { success: true, conversations };
    } catch (error) {
      return fail(req, reply, error, "خطا در دریافت لیست گفتگوها");
    }
  });

  fastify.get("/unread/count", auth, async (req, reply) => {
    try {
      return { success: true, count: await messages.unreadTotal(req.user._id) };
    } catch (error) {
      return fail(req, reply, error, "خطا در دریافت تعداد پیام‌های خوانده نشده");
    }
  });

  fastify.get("/:id", auth, async (req, reply) => {
    try {
      // A browser opening /messages/@alice gets the chat page; the page's own
      // requests ask for JSON and get the history.
      const wantsJson = (req.headers.accept || "").includes("application/json");
      if (req.params.id.startsWith("@") && !wantsJson) {
        return renderChat(req, reply, req.params.id);
      }

      const peerId = await resolvePeerId(req.params.id);
      if (!peerId) {
        return reply
          .status(404)
          .send({ success: false, message: "کاربر مورد نظر یافت نشد" });
      }

      const { error, value: query } = pageQuerySchema.validate(req.query, {
        stripUnknown: true,
      });
      if (error) {
        return reply
          .status(400)
          .send({ success: false, message: "پارامترهای صفحه‌بندی نامعتبر است" });
      }

      const peer = await User.findById(peerId).select("username displayName blockedUsers").lean();
      if (!peer) {
        return reply
          .status(404)
          .send({ success: false, message: "کاربر مورد نظر یافت نشد" });
      }

      const isBlockedByThem = (peer.blockedUsers || []).some((id) =>
        sameId(id, req.user._id),
      );
      if (isBlockedByThem) {
        return reply
          .status(403)
          .send({ success: false, message: "شما توسط این کاربر بلاک شده‌اید" });
      }

      const isFirstPage = !query.before && !query.after && !query.around;
      const [page, pinned] = await Promise.all([
        messages.listMessages(req.user._id, peerId, query),
        isFirstPage ? messages.listPinned(req.user._id, peerId) : null,
      ]);

      return {
        success: true,
        ...page,
        ...(pinned ? { pinned } : {}),
        recipient: {
          _id: peer._id,
          username: peer.username,
          displayName: peer.displayName || "",
          isOnline: !!fastify.isUserOnline?.(peerId),
          isBlockedByThem: false,
          isBlockedByYou: (req.user.blockedUsers || []).some((id) =>
            sameId(id, peerId),
          ),
        },
      };
    } catch (error) {
      return fail(req, reply, error, "خطا در دریافت پیام‌ها");
    }
  });

  fastify.post("/:id", { ...auth, ...rateLimit(120, "1 minute") }, async (req, reply) => {
    try {
      const recipientId = await resolvePeerId(req.params.id);
      if (!recipientId) {
        return reply
          .status(404)
          .send({ success: false, message: "کاربر مورد نظر یافت نشد" });
      }

      const { error, value } = sendSchema.validate(req.body || {}, {
        stripUnknown: true,
      });
      if (error) {
        return reply
          .status(400)
          .send({ success: false, message: error.details[0].message });
      }

      const message = await messages.sendMessage(fastify, {
        senderId: req.user._id,
        recipientId,
        content: value.content,
        replyTo: value.replyTo || null,
      });

      return { success: true, message };
    } catch (error) {
      return fail(req, reply, error, "خطا در ارسال پیام");
    }
  });

  fastify.put("/:id/read-all", auth, async (req, reply) => {
    try {
      if (!requireObjectId(reply, req.params.id)) return;
      await messages.markConversationRead(fastify, req.user._id, req.params.id);
      return { success: true, message: "همه پیام‌ها با موفقیت خوانده شدند" };
    } catch (error) {
      return fail(req, reply, error, "خطا در علامت‌گذاری پیام‌ها");
    }
  });

  fastify.put("/:id/read", auth, async (req, reply) => {
    try {
      if (!requireObjectId(reply, req.params.id)) return;
      await messages.markMessageRead(fastify, req.user._id, req.params.id);
      return { success: true, message: "پیام با موفقیت خوانده شد" };
    } catch (error) {
      return fail(req, reply, error, "خطا در علامت‌گذاری پیام");
    }
  });

  fastify.put("/:id/pin", auth, async (req, reply) => {
    try {
      if (!requireObjectId(reply, req.params.id)) return;
      const pinned = req.body?.pinned !== false;
      const result = await messages.setPinned(
        fastify,
        req.user._id,
        req.params.id,
        pinned,
      );
      return { success: true, ...result };
    } catch (error) {
      return fail(req, reply, error, "خطا در پین کردن پیام");
    }
  });

  fastify.delete("/:id", auth, async (req, reply) => {
    try {
      if (!requireObjectId(reply, req.params.id)) return;
      const forBoth = req.body?.forBoth === true || req.query.forBoth === "true";

      await messages.deleteMessage(fastify, req.user._id, req.params.id, forBoth);

      return {
        success: true,
        message: forBoth ? "پیام برای هر دو طرف حذف شد" : "پیام برای شما حذف شد",
        messageId: req.params.id,
        forBoth,
      };
    } catch (error) {
      return fail(req, reply, error, "خطا در حذف پیام");
    }
  });
};
