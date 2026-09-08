const fp = require("fastify-plugin");

module.exports = fp(async (fastify, opts) => {
  await fastify.register(require("fastify-socket.io"), {
    cors: {
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(",")
        : "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 45000,
    allowEIO3: true,
    maxHttpBufferSize: 1e6,
  });

  fastify.addHook("onReady", () => {
    const onlineUsers = new Map();
    const userSockets = new Map();
    const typingTimeouts = new Map();

    fastify.io.use(async (socket, next) => {
      try {
        const token = extractToken(socket);
        if (!token) return guest(next);

        const decoded = await fastify.verifyAccessToken(token);
        if (!decoded) return guest(next);

        const User = require("../models/User");
        const user = await User.findById(decoded.userId).select("username");
        if (!user) return guest(next);

        socket.userId = decoded.userId;
        socket.username = user.username;
        socket.isAuthenticated = true;
        next();
      } catch (error) {
        fastify.log.error({ error }, "Socket auth error");
        guest(next);
      }
    });

    fastify.io.on("connection", async (socket) => {
      const { userId, isAuthenticated: isAuth, username } = socket;
      console.log(
        `Socket connected: ${socket.id} | User: ${userId || "anonymous"}`,
      );

      if (isAuth && userId) await handleAuthenticated(socket);

      socket.on("message:send", (data) => handleMessageSend(socket, data));
      socket.on("message:read", (data) => handleMessageRead(socket, data));
      socket.on("typing:start", (data) => handleTypingStart(socket, data));
      socket.on("typing:stop", (data) => handleTypingStop(socket, data));
      socket.on("user:active", () => handleUserActive(socket));
      socket.on("post:like", (data) => handlePostLike(socket, data));
      socket.on("comment:like", (data) => handleCommentLike(socket, data));
      socket.on("post:join", (data) => {
        if (data.postId) socket.join(`post:${data.postId}`);
      });
      socket.on("post:leave", (data) => {
        if (data.postId) socket.leave(`post:${data.postId}`);
      });
      socket.on("notification:read", () => handleNotificationRead(socket));
      socket.on("disconnect", () => handleDisconnect(socket));
      socket.on("error", (error) =>
        fastify.log.error({ error, socketId: socket.id }, "Socket error"),
      );
    });

    const guest = (next) => {
      next();
    };

    const extractToken = (socket) => {
      let token =
        socket.handshake.auth?.token ||
        socket.handshake.query?.token ||
        socket.handshake.headers?.authorization?.replace("Bearer ", "");

      if (!token && socket.handshake.headers?.cookie) {
        const match =
          socket.handshake.headers.cookie.match(/accessToken=([^;]+)/);
        if (match) token = match[1];
      }
      return token;
    };

    const emitToUser = (userId, event, data) =>
      fastify.io.to(`user:${userId}`).emit(event, data);

    async function handleAuthenticated(socket) {
      const uid = socket.userId.toString();
      if (!userSockets.has(uid)) userSockets.set(uid, []);
      userSockets.get(uid).push(socket.id);
      onlineUsers.set(uid, socket.id);

      try {
        await fastify.redis.hset("online_users", uid, Date.now().toString());
        await fastify.redis.expire("online_users", 86400);
      } catch (e) {
        fastify.log.error({ error: e }, "Redis error");
      }

      socket.join(`user:${uid}`);
      socket.join(`user:${uid}:notifications`);
      fastify.io.emit("user:online", {
        userId: uid,
        username: socket.username,
        onlineUsers: Array.from(onlineUsers.keys()),
      });

      try {
        const Message = require("../models/Message");
        const unreadCount = await Message.countDocuments({
          recipient: socket.userId,
          isRead: false,
        });
        socket.emit("messages:unread_count", { count: unreadCount });
      } catch (e) {
        fastify.log.error({ error: e }, "Unread count error");
      }
    }

    async function handleMessageSend(socket, data) {
      if (!socket.isAuthenticated)
        return socket.emit("message:error", { message: "احراز هویت لازم است" });
      const { recipientId, content, type = "text" } = data;
      if (!recipientId || !content)
        return socket.emit("message:error", { message: "فرمت نامعتبر" });
      if (content.length > 1000)
        return socket.emit("message:error", { message: "حداکثر 1000 کاراکتر" });

      try {
        const User = require("../models/User"),
          Message = require("../models/Message");
        const recipient = await User.findById(recipientId).select(
          "blockedUsers username",
        );
        if (!recipient)
          return socket.emit("message:error", { message: "کاربر یافت نشد" });
        if (recipient.blockedUsers?.includes(socket.userId))
          return socket.emit("message:error", { message: "شما بلاک شده‌اید" });

        const message = await Message.create({
          sender: socket.userId,
          recipient: recipientId,
          content,
          type,
          isRead: false,
        });
        const populated = await Message.findById(message._id)
          .populate("sender", "username")
          .populate("recipient", "username");

        const recipientSockets = userSockets.get(recipientId.toString()) || [];
        recipientSockets.forEach((sid) =>
          fastify.io.to(sid).emit("message:new", populated),
        );
        fastify.io
          .to(`user:${recipientId}:notifications`)
          .emit("notification:new", {
            type: "message",
            from: socket.userId,
            message: populated,
          });
        socket.emit("message:sent", populated);

        const unreadCount = await Message.countDocuments({
          recipient: recipientId,
          isRead: false,
        });
        emitToUser(recipientId, "messages:unread_count", {
          count: unreadCount,
        });
      } catch (error) {
        fastify.log.error({ error }, "Message send error");
        socket.emit("message:error", { message: "خطا در ارسال" });
      }
    }

    async function handleMessageRead(socket, data) {
      if (!socket.isAuthenticated) return;
      const { messageId, userId: senderId } = data;
      const Message = require("../models/Message");

      try {
        if (messageId) {
          const msg = await Message.findOne({
            _id: messageId,
            recipient: socket.userId,
          });
          if (msg && !msg.isRead) {
            msg.isRead = true;
            msg.readAt = new Date();
            await msg.save();
            if (msg.sender)
              emitToUser(msg.sender, "message:read", {
                messageId,
                recipientId: socket.userId,
              });
          }
        } else if (senderId) {
          await Message.updateMany(
            { sender: senderId, recipient: socket.userId, isRead: false },
            { $set: { isRead: true, readAt: new Date() } },
          );
          emitToUser(senderId, "messages:read", { userId: socket.userId });
        }

        const unreadCount = await Message.countDocuments({
          recipient: socket.userId,
          isRead: false,
        });
        socket.emit("messages:unread_count", { count: unreadCount });
        if (senderId) {
          const senderUnread = await Message.countDocuments({
            recipient: senderId,
            isRead: false,
          });
          emitToUser(senderId, "messages:unread_count", {
            count: senderUnread,
          });
        }
      } catch (error) {
        fastify.log.error({ error }, "Message read error");
      }
    }

    function handleTypingStart(socket, data) {
      if (!socket.isAuthenticated || !data.recipientId) return;
      emitToUser(data.recipientId, "typing:start", {
        userId: socket.userId,
        username: socket.username || "کاربر",
      });
      const key = `${socket.userId}:${data.recipientId}`;
      if (typingTimeouts.has(key)) clearTimeout(typingTimeouts.get(key));
      typingTimeouts.set(
        key,
        setTimeout(() => {
          emitToUser(data.recipientId, "typing:stop", {
            userId: socket.userId,
          });
          typingTimeouts.delete(key);
        }, 5000),
      );
    }

    function handleTypingStop(socket, data) {
      if (!socket.isAuthenticated || !data.recipientId) return;
      emitToUser(data.recipientId, "typing:stop", { userId: socket.userId });
      const key = `${socket.userId}:${data.recipientId}`;
      if (typingTimeouts.has(key)) {
        clearTimeout(typingTimeouts.get(key));
        typingTimeouts.delete(key);
      }
    }

    function handleUserActive(socket) {
      if (!socket.isAuthenticated) return;
      try {
        fastify.redis.hset(
          "online_users",
          socket.userId.toString(),
          Date.now().toString(),
        );
      } catch (e) {}
    }

    async function handlePostLike(socket, data) {
      if (!socket.isAuthenticated) return;
      try {
        const Post = require("../models/Post");
        const post = await Post.findById(data.postId);
        if (!post) return;
        const uid = socket.userId.toString();
        const likeIndex = post.likes.indexOf(uid);
        if (likeIndex === -1) post.likes.push(uid);
        else post.likes.splice(likeIndex, 1);
        await post.save();
        const liked = likeIndex === -1;
        fastify.io.emit("post:liked", {
          postId: data.postId,
          likesCount: post.likes.length,
          userId: uid,
          liked,
        });
        if (liked && post.author.toString() !== uid)
          await createNotification(post.author, socket.userId, "like", {
            postId: data.postId,
            message: "پست شما را لایک کرد",
          });
      } catch (error) {
        fastify.log.error({ error }, "Post like error");
      }
    }

    async function handleCommentLike(socket, data) {
      if (!socket.isAuthenticated) return;
      try {
        const Comment = require("../models/Comment");
        const comment = await Comment.findById(data.commentId);
        if (!comment) return;
        const uid = socket.userId.toString();
        const likeIndex = comment.likes.indexOf(uid);
        if (likeIndex === -1) comment.likes.push(uid);
        else comment.likes.splice(likeIndex, 1);
        comment.likesCount = comment.likes.length;
        await comment.save();
        const liked = likeIndex === -1;
        fastify.io.emit("comment:liked", {
          commentId: data.commentId,
          likesCount: comment.likesCount,
          userId: uid,
          liked,
        });
        if (liked && comment.author.toString() !== uid)
          await createNotification(
            comment.author,
            socket.userId,
            "like_comment",
            {
              commentId: data.commentId,
              postId: comment.post,
              message: "کامنت شما را لایک کرد",
            },
          );
      } catch (error) {
        fastify.log.error({ error }, "Comment like error");
      }
    }

    async function createNotification(recipientId, senderId, type, data) {
      const Notification = require("../models/Notification");
      const notification = await Notification.create({
        recipient: recipientId,
        sender: senderId,
        type,
        ...data,
      });
      fastify.io
        .to(`user:${recipientId}:notifications`)
        .emit("notification:new", {
          _id: notification._id,
          type,
          message: notification.message,
          sender: senderId,
          ...data,
          createdAt: notification.createdAt,
        });
    }

    async function handleNotificationRead(socket) {
      if (!socket.isAuthenticated) return;
      try {
        const Notification = require("../models/Notification");
        await Notification.updateMany(
          { recipient: socket.userId, isRead: false },
          { isRead: true, readAt: new Date() },
        );
        socket.emit("notification:read_all", { success: true });
      } catch (e) {
        fastify.log.error({ error: e }, "Notification read error");
      }
    }

    async function handleDisconnect(socket) {
      if (!socket.isAuthenticated) return;
      const uid = socket.userId.toString();

      for (const [key, timeout] of typingTimeouts.entries()) {
        if (key.startsWith(`${uid}:`)) {
          clearTimeout(timeout);
          emitToUser(key.split(":")[1], "typing:stop", { userId: uid });
          typingTimeouts.delete(key);
        }
      }

      const sockets = userSockets.get(uid) || [];
      const index = sockets.indexOf(socket.id);
      if (index > -1) sockets.splice(index, 1);

      if (sockets.length === 0) {
        userSockets.delete(uid);
        onlineUsers.delete(uid);
        try {
          await fastify.redis.hdel("online_users", uid);
        } catch (e) {}
        fastify.io.emit("user:offline", {
          userId: uid,
          username: socket.username,
          onlineUsers: Array.from(onlineUsers.keys()),
        });
      }
    }
  });

  fastify.addHook("onClose", async () => {
    try {
      await fastify.io.close();
      fastify.log.info("Socket.IO closed");
    } catch (error) {
      fastify.log.error({ err: error }, "Error closing Socket.IO");
    }
  });
});
