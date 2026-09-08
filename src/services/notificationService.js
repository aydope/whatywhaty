const Notification = require("../models/Notification");

const NOTIFICATION_MESSAGES = Object.freeze({
  comment: "روی پست شما کامنت گذاشت",
  reply: "به کامنت شما پاسخ داد",
  like: "پست شما را لایک کرد",
  like_comment: "کامنت شما را لایک کرد",
  follow: "شما را دنبال کرد",
  message: "به شما پیام داد",
});

const getDefaultMessage = (type) => NOTIFICATION_MESSAGES[type] || "اعلان جدید";

const sendNotification = async (
  fastify,
  recipientId,
  senderId,
  type,
  data = {},
) => {
  if (!recipientId || !senderId || !type) {
    fastify.log.warn("Invalid notification parameters", {
      recipientId,
      senderId,
      type,
    });
    return null;
  }

  if (recipientId.toString() === senderId.toString()) {
    fastify.log.debug("Skipping self-notification", { type });
    return null;
  }

  try {
    const notification = await Notification.create({
      recipient: recipientId,
      sender: senderId,
      type,
      message: data.message || getDefaultMessage(type),
      postId: data.postId || null,
      commentId: data.commentId || null,
    });

    const populatedNotification = await Notification.findById(notification._id)
      .populate("sender", "username avatar")
      .lean();

    if (fastify.io) {
      const room = `user:${recipientId}:notifications`;
      fastify.io.to(room).emit("notification:new", populatedNotification);
      fastify.log.debug("Notification emitted", {
        room,
        notificationId: notification._id,
      });
    }

    return populatedNotification;
  } catch (error) {
    fastify.log.error("Failed to create notification", {
      error: error.message,
      recipientId,
      senderId,
      type,
    });
    return null;
  }
};

module.exports = { sendNotification };
