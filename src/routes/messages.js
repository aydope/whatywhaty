const Message = require("../models/Message");
const User = require("../models/User");
const mongoose = require("mongoose");
const { sendNotification } = require("../services/notificationService");

const isValidObjectId = (id) => id && mongoose.Types.ObjectId.isValid(id);

const getUserOnlineStatus = async (fastify, userId) => {
  const onlineUsers = (await fastify.redis.hgetall("online_users")) || {};
  return !!onlineUsers[userId?.toString()];
};

const emitToUser = (fastify, userId, event, data) => {
  fastify.io?.to(`user:${userId}`).emit(event, data);
};

module.exports = async function (fastify, opts) {
  const auth = { preHandler: [fastify.authenticate] };

  fastify.get("/", auth, async (req, reply) => {
    const preselectedUser = req.query.user || null;

    return reply.view("messages.ejs", {
      user: req.user,
      preselectedUser,
      title: "پیام‌ها",
    });
  });

  fastify.get("/conversations", auth, async (req, reply) => {
    try {
      const userId = req.user._id;

      const conversations = await Message.aggregate([
        {
          $match: {
            $or: [{ sender: userId }, { recipient: userId }],
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: {
              $cond: [{ $eq: ["$sender", userId] }, "$recipient", "$sender"],
            },
            lastMessage: { $first: "$$ROOT" },
            unreadCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$recipient", userId] },
                      { $eq: ["$isRead", false] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
        { $sort: { "lastMessage.createdAt": -1 } },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: "$user" },
        {
          $project: {
            "user._id": 1,
            "user.username": 1,
            lastMessage: {
              _id: 1,
              content: 1,
              createdAt: 1,
              isRead: 1,
              type: 1,
              sender: 1,
            },
            unreadCount: 1,
          },
        },
      ]);

      const onlineUsers = (await fastify.redis.hgetall("online_users")) || {};

      const conversationsWithStatus = conversations.map((conv) => ({
        ...conv,
        user: {
          ...conv.user,
          isOnline: !!onlineUsers[conv.user._id.toString()],
        },
      }));

      return reply.status(200).send({
        success: true,
        conversations: conversationsWithStatus,
      });
    } catch (error) {
      req.log.error({ error, userId: req.user._id }, "Get conversations error");
      return reply.status(500).send({
        success: false,
        message: "خطا در دریافت لیست گفتگوها",
      });
    }
  });

  fastify.get("/:userId", auth, async (req, reply) => {
    try {
      const { userId } = req.params;
      const currentUserId = req.user._id;

      if (!isValidObjectId(userId)) {
        return reply.status(400).send({
          success: false,
          message: "شناسه کاربر نامعتبر است",
        });
      }

      const recipient = await User.findById(userId).select(
        "username blockedUsers isBlocked",
      );

      if (!recipient) {
        return reply.status(404).send({
          success: false,
          message: "کاربر مورد نظر یافت نشد",
        });
      }

      if (recipient.isBlocked) {
        return reply.status(403).send({
          success: false,
          message: "این کاربر مسدود شده است",
        });
      }

      if (recipient.blockedUsers?.includes(currentUserId)) {
        return reply.status(403).send({
          success: false,
          message: "شما توسط این کاربر بلاک شده‌اید",
        });
      }

      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
      const skip = (page - 1) * limit;

      const filter = {
        $or: [
          {
            sender: currentUserId,
            recipient: userId,
            deletedForSender: { $ne: true },
          },
          {
            sender: userId,
            recipient: currentUserId,
            deletedForRecipient: { $ne: true },
          },
        ],
      };

      const [messages, total] = await Promise.all([
        Message.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate("sender", "username")
          .populate("recipient", "username")
          .lean(),
        Message.countDocuments(filter),
      ]);

      const isOnline = await getUserOnlineStatus(fastify, userId);

      return reply.status(200).send({
        success: true,
        messages: messages.reverse(),
        recipient: {
          _id: recipient._id,
          username: recipient.username,
          isOnline,
        },
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasMore: page < Math.ceil(total / limit),
        },
      });
    } catch (error) {
      req.log.error({ error, userId: req.params.userId }, "Get messages error");
      return reply.status(500).send({
        success: false,
        message: "خطا در دریافت پیام‌ها",
      });
    }
  });

  fastify.post("/:userId", auth, async (req, reply) => {
    try {
      const { userId } = req.params;
      const { content, type = "text" } = req.body;
      const currentUserId = req.user._id;

      if (!isValidObjectId(userId)) {
        return reply.status(400).send({
          success: false,
          message: "شناسه کاربر نامعتبر است",
        });
      }

      if (!content || content.trim().length === 0) {
        return reply.status(400).send({
          success: false,
          message: "متن پیام نمی‌تواند خالی باشد",
        });
      }

      if (content.length > 1000) {
        return reply.status(400).send({
          success: false,
          message: "پیام نمی‌تواند بیشتر از 1000 کاراکتر باشد",
        });
      }

      const recipient = await User.findById(userId).select(
        "username blockedUsers isBlocked",
      );

      if (!recipient) {
        return reply.status(404).send({
          success: false,
          message: "کاربر مورد نظر یافت نشد",
        });
      }

      if (recipient.isBlocked) {
        return reply.status(403).send({
          success: false,
          message: "این کاربر مسدود شده است",
        });
      }

      if (recipient.blockedUsers?.includes(currentUserId)) {
        return reply.status(403).send({
          success: false,
          message: "شما توسط این کاربر بلاک شده‌اید",
        });
      }

      const message = await Message.create({
        sender: currentUserId,
        recipient: userId,
        content: content.trim(),
        type,
        isRead: false,
      });

      const populatedMessage = await Message.findById(message._id)
        .populate("sender", "username")
        .populate("recipient", "username");

      emitToUser(fastify, userId, "message:new", populatedMessage);
      emitToUser(fastify, userId, "notification:new", {
        type: "message",
        from: currentUserId,
        message: populatedMessage,
      });
      emitToUser(fastify, currentUserId, "message:sent", populatedMessage);

      const unreadCount = await Message.countDocuments({
        recipient: userId,
        isRead: false,
      });

      emitToUser(fastify, userId, "messages:unread_count", {
        count: unreadCount,
      });

      await sendNotification(fastify, userId, currentUserId, "message", {
        message: "به شما پیام داد",
      });

      return reply.status(200).send({
        success: true,
        message: populatedMessage,
      });
    } catch (error) {
      req.log.error({ error, userId: req.params.userId }, "Send message error");
      return reply.status(500).send({
        success: false,
        message: "خطا در ارسال پیام",
      });
    }
  });

  fastify.put("/:messageId/read", auth, async (req, reply) => {
    try {
      const { messageId } = req.params;
      const currentUserId = req.user._id;

      const message = await Message.findOne({
        _id: messageId,
        recipient: currentUserId,
      });

      if (!message) {
        return reply.status(404).send({
          success: false,
          message: "پیام مورد نظر یافت نشد",
        });
      }

      if (!message.isRead) {
        message.isRead = true;
        message.readAt = new Date();
        await message.save();

        emitToUser(fastify, message.sender, "message:read", {
          messageId,
          recipientId: currentUserId,
        });
      }

      const unreadCount = await Message.countDocuments({
        recipient: currentUserId,
        isRead: false,
      });

      emitToUser(fastify, currentUserId, "messages:unread_count", {
        count: unreadCount,
      });

      return reply.status(200).send({
        success: true,
        message: "پیام با موفقیت خوانده شد",
      });
    } catch (error) {
      req.log.error(
        { error, messageId: req.params.messageId },
        "Mark message read error",
      );
      return reply.status(500).send({
        success: false,
        message: "خطا در علامت‌گذاری پیام",
      });
    }
  });

  fastify.put("/:userId/read-all", auth, async (req, reply) => {
    try {
      const { userId } = req.params;
      const currentUserId = req.user._id;

      await Message.updateMany(
        { sender: userId, recipient: currentUserId, isRead: false },
        { $set: { isRead: true, readAt: new Date() } },
      );

      const unreadCount = await Message.countDocuments({
        recipient: currentUserId,
        isRead: false,
      });

      emitToUser(fastify, currentUserId, "messages:unread_count", {
        count: unreadCount,
      });
      emitToUser(fastify, userId, "messages:read", { userId: currentUserId });

      return reply.status(200).send({
        success: true,
        message: "همه پیام‌ها با موفقیت خوانده شدند",
      });
    } catch (error) {
      req.log.error(
        { error, userId: req.params.userId },
        "Mark all messages read error",
      );
      return reply.status(500).send({
        success: false,
        message: "خطا در علامت‌گذاری پیام‌ها",
      });
    }
  });

  fastify.get("/unread/count", auth, async (req, reply) => {
    try {
      const count = await Message.countDocuments({
        recipient: req.user._id,
        isRead: false,
      });

      return reply.status(200).send({
        success: true,
        count,
      });
    } catch (error) {
      req.log.error({ error, userId: req.user._id }, "Get unread count error");
      return reply.status(500).send({
        success: false,
        message: "خطا در دریافت تعداد پیام‌های خوانده نشده",
      });
    }
  });

  fastify.delete("/:messageId", auth, async (req, reply) => {
    try {
      const { messageId } = req.params;
      const currentUserId = req.user._id;
      const { forBoth = false } = req.body;

      const message = await Message.findById(messageId);

      if (!message) {
        return reply.status(404).send({
          success: false,
          message: "پیام مورد نظر یافت نشد",
        });
      }

      const isSender = message.sender.toString() === currentUserId.toString();
      const isRecipient =
        message.recipient.toString() === currentUserId.toString();

      if (!isSender && !isRecipient) {
        return reply.status(403).send({
          success: false,
          message: "شما اجازه حذف این پیام را ندارید",
        });
      }

      if (isSender) {
        if (forBoth) {
          await Message.findByIdAndDelete(messageId);
          emitToUser(fastify, message.recipient, "message:deleted", {
            messageId,
            deletedBy: currentUserId,
            forBoth: true,
          });
        } else {
          message.deletedForSender = true;
          await message.save();
        }
      } else if (isRecipient) {
        if (forBoth) {
          await Message.findByIdAndDelete(messageId);
          emitToUser(fastify, message.sender, "message:deleted", {
            messageId,
            deletedBy: currentUserId,
            forBoth: true,
          });
        } else {
          message.deletedForRecipient = true;
          await message.save();
        }
      }

      emitToUser(fastify, currentUserId, "message:deleted:self", {
        messageId,
        forBoth,
      });

      return reply.status(200).send({
        success: true,
        message: forBoth
          ? "پیام برای هر دو طرف حذف شد"
          : "پیام برای شما حذف شد",
        messageId,
        forBoth,
      });
    } catch (error) {
      req.log.error(
        { error, messageId: req.params.messageId },
        "Delete message error",
      );
      return reply.status(500).send({
        success: false,
        message: "خطا در حذف پیام",
      });
    }
  });
};
