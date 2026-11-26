const Message = require("../models/Message");
const User = require("../models/User");
const { isObjectId, sameId, toObjectId } = require("../utils/ids");

const MAX_CONTENT_LENGTH = 1000;
const MAX_PINNED = 20;
const REPLY_PREVIEW_LENGTH = 120;

class ServiceError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const emitToUser = (fastify, userId, event, data) =>
  fastify.io?.to(`user:${userId}`).emit(event, data);

const pairFilter = (userId, peerId) => ({
  $or: [
    { sender: userId, recipient: peerId, deletedForSender: { $ne: true } },
    { sender: peerId, recipient: userId, deletedForRecipient: { $ne: true } },
  ],
});

const populateMessage = (query) =>
  query
    .populate("sender", "username displayName")
    .populate("recipient", "username displayName");

const isDeletedFor = (message, userId) =>
  (sameId(message.sender, userId) && message.deletedForSender) ||
  (sameId(message.recipient, userId) && message.deletedForRecipient);

// A reply keeps the id of its original even after that message was removed,
// so a missing target is reported as deleted instead of vanishing.
const serializeReply = (reply, viewerId) => {
  if (!reply || isDeletedFor(reply, viewerId)) return { deleted: true };
  return {
    _id: reply._id,
    deleted: false,
    sender: reply.sender,
    type: reply.type,
    content: reply.content.slice(0, REPLY_PREVIEW_LENGTH),
  };
};

// Shapes a message for one viewer: hides the original of a reply once it was
// deleted for them and drops internal flags.
const serializeMessage = (message, viewerId, replies = new Map()) => {
  const m = message.toObject ? message.toObject() : message;
  return {
    _id: m._id,
    sender: m.sender,
    recipient: m.recipient,
    content: m.content,
    type: m.type,
    isRead: m.isRead,
    readAt: m.readAt,
    createdAt: m.createdAt,
    pinned: !!m.pinned,
    pinnedAt: m.pinnedAt,
    replyTo: m.replyTo
      ? serializeReply(replies.get(m.replyTo.toString()), viewerId)
      : null,
  };
};

const loadReplies = async (messages) => {
  const ids = [
    ...new Set(messages.map((m) => m.replyTo?.toString()).filter(Boolean)),
  ];
  if (!ids.length) return new Map();

  const targets = await Message.find({ _id: { $in: ids } })
    .select("content type sender recipient deletedForSender deletedForRecipient")
    .lean();
  return new Map(targets.map((t) => [t._id.toString(), t]));
};

const serializeMany = async (messages, viewerId) => {
  const replies = await loadReplies(messages);
  return messages.map((m) => serializeMessage(m, viewerId, replies));
};

const unreadTotal = (userId) =>
  Message.countDocuments({
    recipient: userId,
    isRead: false,
    deletedForRecipient: { $ne: true },
  });

const pushUnreadCount = async (fastify, userId) =>
  emitToUser(fastify, userId, "messages:unread_count", {
    count: await unreadTotal(userId),
  });

// Both directions of a block are checked here so REST and socket senders
// follow exactly the same rules.
const assertCanMessage = async (senderId, recipientId) => {
  if (!isObjectId(recipientId.toString())) {
    throw new ServiceError("شناسه کاربر نامعتبر است", 400);
  }
  if (sameId(senderId, recipientId)) {
    throw new ServiceError("نمی‌توانید به خودتان پیام بدهید", 400);
  }

  const users = await User.find({ _id: { $in: [senderId, recipientId] } })
    .select("blockedUsers")
    .lean();
  const sender = users.find((u) => sameId(u._id, senderId));
  const recipient = users.find((u) => sameId(u._id, recipientId));

  if (!recipient) throw new ServiceError("کاربر مورد نظر یافت نشد", 404);
  if ((recipient.blockedUsers || []).some((id) => sameId(id, senderId))) {
    throw new ServiceError("شما توسط این کاربر بلاک شده‌اید", 403);
  }
  if ((sender?.blockedUsers || []).some((id) => sameId(id, recipientId))) {
    throw new ServiceError("شما این کاربر را بلاک کرده‌اید", 403);
  }
};

const sendMessage = async (fastify, { senderId, recipientId, content, replyTo }) => {
  if (typeof content !== "string" || !content.trim()) {
    throw new ServiceError("متن پیام نمی‌تواند خالی باشد", 400);
  }
  const text = content.trim();
  if (text.length > MAX_CONTENT_LENGTH) {
    throw new ServiceError("پیام نمی‌تواند بیشتر از 1000 کاراکتر باشد", 400);
  }

  await assertCanMessage(senderId, recipientId);

  let replyTarget = null;
  if (replyTo) {
    if (!isObjectId(String(replyTo))) {
      throw new ServiceError("پیام مورد نظر برای پاسخ نامعتبر است", 400);
    }
    replyTarget = await Message.findOne({
      _id: replyTo,
      ...pairFilter(senderId, recipientId),
    })
      .select("_id")
      .lean();
    if (!replyTarget) {
      throw new ServiceError("پیام مورد نظر برای پاسخ یافت نشد", 404);
    }
  }

  const created = await Message.create({
    sender: senderId,
    recipient: recipientId,
    content: text,
    replyTo: replyTarget?._id || null,
  });
  const message = await populateMessage(Message.findById(created._id));

  const replies = await loadReplies([message]);
  const forRecipient = serializeMessage(message, recipientId, replies);
  const forSender = serializeMessage(message, senderId, replies);

  emitToUser(fastify, recipientId, "message:new", forRecipient);
  emitToUser(fastify, senderId, "message:sent", forSender);
  await pushUnreadCount(fastify, recipientId);

  return forSender;
};

const markConversationRead = async (fastify, readerId, peerId) => {
  if (!isObjectId(peerId.toString())) {
    throw new ServiceError("شناسه کاربر نامعتبر است", 400);
  }

  const readAt = new Date();
  const result = await Message.updateMany(
    { sender: peerId, recipient: readerId, isRead: false },
    { $set: { isRead: true, readAt } },
  );

  if (result.modifiedCount > 0) {
    emitToUser(fastify, peerId, "messages:read", { userId: readerId.toString(), readAt });
    await pushUnreadCount(fastify, readerId);
  }
  return result.modifiedCount;
};

const markMessageRead = async (fastify, readerId, messageId) => {
  const message = await Message.findOneAndUpdate(
    { _id: messageId, recipient: readerId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
  )
    .select("sender")
    .lean();

  if (!message) return false;

  emitToUser(fastify, message.sender, "message:read", {
    messageId,
    recipientId: readerId.toString(),
  });
  await pushUnreadCount(fastify, readerId);
  return true;
};

const findOwnMessage = async (userId, messageId) => {
  if (!isObjectId(String(messageId))) {
    throw new ServiceError("شناسه پیام نامعتبر است", 400);
  }
  const message = await Message.findById(messageId);
  const isParticipant =
    message && (sameId(message.sender, userId) || sameId(message.recipient, userId));

  if (!message || (isParticipant && isDeletedFor(message, userId))) {
    throw new ServiceError("پیام مورد نظر یافت نشد", 404);
  }
  if (!isParticipant) {
    throw new ServiceError("شما اجازه دسترسی به این پیام را ندارید", 403);
  }
  return message;
};

const deleteMessage = async (fastify, userId, messageId, forBoth) => {
  const message = await findOwnMessage(userId, messageId);
  const isSender = sameId(message.sender, userId);
  const peerId = isSender ? message.recipient : message.sender;

  if (forBoth) {
    await message.deleteOne();
    emitToUser(fastify, peerId, "message:deleted", {
      messageId,
      forBoth: true,
      peerId: userId.toString(),
    });
  } else {
    message[isSender ? "deletedForSender" : "deletedForRecipient"] = true;
    // Once neither side can see the message there is no reason to keep it.
    if (message.deletedForSender && message.deletedForRecipient) {
      await message.deleteOne();
    } else {
      await message.save();
    }
  }

  emitToUser(fastify, userId, "message:deleted:self", {
    messageId,
    forBoth,
    peerId: peerId.toString(),
  });

  if (!message.isRead) {
    await Promise.all([
      pushUnreadCount(fastify, message.recipient),
    ]);
  }

  return { peerId: peerId.toString() };
};

const setPinned = async (fastify, userId, messageId, pinned) => {
  const message = await findOwnMessage(userId, messageId);
  const peerId = sameId(message.sender, userId) ? message.recipient : message.sender;

  if (pinned && !message.pinned) {
    const count = await Message.countDocuments({
      pinned: true,
      ...pairFilter(userId, peerId),
    });
    if (count >= MAX_PINNED) {
      throw new ServiceError(`حداکثر ${MAX_PINNED} پیام را می‌توان پین کرد`, 400);
    }
  }

  message.pinned = pinned;
  message.pinnedAt = pinned ? new Date() : null;
  message.pinnedBy = pinned ? userId : null;
  await message.save();

  const payload = {
    messageId: message._id.toString(),
    pinned,
    pinnedAt: message.pinnedAt,
  };
  emitToUser(fastify, userId, "message:pinned", { ...payload, peerId: peerId.toString() });
  emitToUser(fastify, peerId, "message:pinned", { ...payload, peerId: userId.toString() });

  return payload;
};

const listPinned = async (userId, peerId) => {
  const pinned = await populateMessage(
    Message.find({ pinned: true, ...pairFilter(userId, peerId) })
      .sort({ pinnedAt: -1 })
      .limit(MAX_PINNED),
  );
  return serializeMany(pinned, userId);
};

// Cursor based paging over _id: `before` loads older messages, `after` newer
// ones and `around` returns a window centred on one message (jump to reply).
const listMessages = async (userId, peerId, { before, after, around, limit }) => {
  const base = pairFilter(userId, peerId);
  const find = (extra, sort, size) =>
    populateMessage(Message.find({ ...base, ...extra }).sort({ _id: sort }).limit(size));

  let older = [];
  let newer = [];
  let hasMoreOlder = false;
  let hasMoreNewer = false;

  if (around) {
    const half = Math.ceil(limit / 2);
    const [olderRows, newerRows] = await Promise.all([
      find({ _id: { $lt: toObjectId(around) } }, -1, half + 1),
      find({ _id: { $gte: toObjectId(around) } }, 1, half + 1),
    ]);
    hasMoreOlder = olderRows.length > half;
    hasMoreNewer = newerRows.length > half;
    older = olderRows.slice(0, half).reverse();
    newer = newerRows.slice(0, half);
  } else if (after) {
    const rows = await find({ _id: { $gt: toObjectId(after) } }, 1, limit + 1);
    hasMoreNewer = rows.length > limit;
    newer = rows.slice(0, limit);
  } else {
    const rows = await find(before ? { _id: { $lt: toObjectId(before) } } : {}, -1, limit + 1);
    hasMoreOlder = rows.length > limit;
    older = rows.slice(0, limit).reverse();
  }

  return {
    messages: await serializeMany([...older, ...newer], userId),
    hasMoreOlder,
    hasMoreNewer,
  };
};

// One row per conversation. The last message is the highest _id, so no sort
// over message bodies is needed and only small documents are loaded.
const listConversations = async (fastify, user, limit = 100) => {
  const userId = user._id;

  const groups = await Message.aggregate([
    {
      $match: {
        $or: [
          { sender: userId, deletedForSender: { $ne: true } },
          { recipient: userId, deletedForRecipient: { $ne: true } },
        ],
      },
    },
    {
      $group: {
        _id: { $cond: [{ $eq: ["$sender", userId] }, "$recipient", "$sender"] },
        lastId: { $max: "$_id" },
        unreadCount: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ["$recipient", userId] }, { $eq: ["$isRead", false] }] },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { lastId: -1 } },
    { $limit: limit },
  ]);

  if (!groups.length) return [];

  const [lastMessages, partners] = await Promise.all([
    Message.find({ _id: { $in: groups.map((g) => g.lastId) } })
      .select("content createdAt isRead type sender")
      .lean(),
    User.find({ _id: { $in: groups.map((g) => g._id) } })
      .select("username displayName blockedUsers")
      .lean(),
  ]);

  const lastById = new Map(lastMessages.map((m) => [m._id.toString(), m]));
  const partnerById = new Map(partners.map((p) => [p._id.toString(), p]));
  const blockedByYou = new Set((user.blockedUsers || []).map(String));

  return groups
    .filter((g) => partnerById.has(g._id.toString()))
    .map((g) => {
      const partner = partnerById.get(g._id.toString());
      return {
        _id: g._id,
        lastMessage: lastById.get(g.lastId.toString()),
        unreadCount: g.unreadCount,
        user: {
          _id: partner._id,
          username: partner.username,
          displayName: partner.displayName || "",
          isOnline: !!fastify.isUserOnline?.(partner._id.toString()),
          isBlockedByYou: blockedByYou.has(partner._id.toString()),
          isBlockedByThem: (partner.blockedUsers || []).some((id) => sameId(id, userId)),
        },
      };
    });
};

module.exports = {
  ServiceError,
  emitToUser,
  sendMessage,
  markConversationRead,
  markMessageRead,
  deleteMessage,
  setPinned,
  listPinned,
  listMessages,
  listConversations,
  unreadTotal,
  pushUnreadCount,
  assertCanMessage,
};
