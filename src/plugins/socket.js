const fp = require("fastify-plugin");
const User = require("../models/User");
const Notification = require("../models/Notification");
const messages = require("../services/messageService");
const { likePost, likeComment } = require("../services/reactionService");
const { isObjectId } = require("../utils/ids");

const MAX_PRESENCE_WATCHES = 200;
const MAX_POST_ROOMS = 50;
const TYPING_TIMEOUT_MS = 5000;
const CAN_MESSAGE_TTL_MS = 30000;

const asObject = (data) =>
  data && typeof data === "object" && !Array.isArray(data) ? data : {};

const parseCookies = (header = "") =>
  Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split(/=(.*)/s).slice(0, 2))
      .filter(([name]) => name),
  );

module.exports = fp(async (fastify) => {
  const isProduction = process.env.NODE_ENV === "production";
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
    : null;

  await fastify.register(require("fastify-socket.io"), {
    cors: allowedOrigins
      ? { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true }
      : undefined,
    // Cross-site pages must not be able to open an authenticated socket with
    // the visitor's cookies.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (!origin || !isProduction) return callback(null, true);

      let host = null;
      try {
        host = new URL(origin).host;
      } catch {}
      callback(
        null,
        host === req.headers.host || !!allowedOrigins?.includes(origin),
      );
    },
    transports: ["websocket", "polling"],
    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 45000,
    maxHttpBufferSize: 1e5,
  });

  const io = () => fastify.io;
  const roomSize = (room) => io().sockets.adapter.rooms.get(room)?.size || 0;
  const isUserOnline = (userId) => roomSize(`user:${userId}`) > 0;
  fastify.decorate("isUserOnline", isUserOnline);

  const resolveUser = async (socket) => {
    const cookies = parseCookies(socket.handshake.headers?.cookie);
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer /, "") ||
      cookies.accessToken;

    const decoded = await fastify.verifyAccessToken(token);
    if (decoded && !decoded.expired) {
      const user = await User.findById(decoded.userId).select(
        "username tokenVersion",
      );
      const stale = user && (decoded.v || 0) !== (user.tokenVersion || 0);
      return user && !stale ? user : null;
    }

    // An expired access token is fine as long as the session behind the
    // refresh cookie is still active.
    const refreshed = await fastify.verifyRefreshToken(cookies.refreshToken);
    if (refreshed && !refreshed.expired) {
      return User.findById(refreshed.userId).select("username");
    }
    return null;
  };

  fastify.addHook("onReady", () => {
    const typingTimers = new Map();

    io().use(async (socket, next) => {
      try {
        const user = await resolveUser(socket);
        if (user) {
          socket.userId = user._id.toString();
          socket.username = user.username;
          socket.isAuthenticated = true;
        }
      } catch (error) {
        fastify.log.error({ err: error }, "Socket auth error");
      }
      next();
    });

    io().on("connection", (socket) => {
      socket.data.buckets = new Map();
      socket.data.postRooms = new Set();
      socket.data.watched = new Set();
      socket.data.canMessage = new Map();

      // Fixed window limiter so one socket cannot flood the server.
      const allow = (key, max, windowMs) => {
        const now = Date.now();
        const bucket = socket.data.buckets.get(key);
        if (!bucket || now > bucket.resetAt) {
          socket.data.buckets.set(key, { count: 1, resetAt: now + windowMs });
          return true;
        }
        bucket.count += 1;
        return bucket.count <= max;
      };

      // Every handler runs inside this wrapper: a malformed payload or a
      // failing query is logged and answered, and can never crash the process.
      const on = (event, { auth = true, limit } = {}, handler) => {
        socket.on(event, async (payload, ack) => {
          const reply = typeof ack === "function" ? ack : () => {};
          try {
            if (auth && !socket.isAuthenticated) {
              return reply({ success: false, message: "احراز هویت لازم است" });
            }
            if (limit && !allow(event, limit[0], limit[1])) {
              return reply({ success: false, message: "تعداد درخواست‌ها زیاد است" });
            }
            await handler(asObject(payload), reply);
          } catch (error) {
            if (error.statusCode && error.statusCode < 500) {
              reply({ success: false, message: error.message });
              socket.emit("message:error", { message: error.message });
              return;
            }
            fastify.log.error({ err: error, event }, "Socket handler error");
            reply({ success: false, message: "خطای سرور" });
          }
        });
      };

      const stopTyping = (recipientId) => {
        const key = `${socket.userId}:${recipientId}`;
        clearTimeout(typingTimers.get(key));
        typingTimers.delete(key);
        messages.emitToUser(fastify, recipientId, "typing:stop", {
          userId: socket.userId,
        });
      };

      const canMessage = async (recipientId) => {
        const cached = socket.data.canMessage.get(recipientId);
        if (cached && cached.expiresAt > Date.now()) return cached.ok;

        let ok = true;
        try {
          await messages.assertCanMessage(socket.userId, recipientId);
        } catch {
          ok = false;
        }
        socket.data.canMessage.set(recipientId, {
          ok,
          expiresAt: Date.now() + CAN_MESSAGE_TTL_MS,
        });
        return ok;
      };

      if (socket.isAuthenticated) {
        const wasOffline = !isUserOnline(socket.userId);
        socket.join(`user:${socket.userId}`);
        socket.join(`user:${socket.userId}:notifications`);

        if (wasOffline) {
          io().to(`presence:${socket.userId}`).emit("user:online", {
            userId: socket.userId,
            username: socket.username,
          });
        }
        messages.pushUnreadCount(fastify, socket.userId).catch((error) =>
          fastify.log.error({ err: error }, "Unread count error"),
        );
      }

      on("message:send", { limit: [60, 60000] }, async (data, reply) => {
        if (!isObjectId(data.recipientId)) {
          return reply({ success: false, message: "فرمت نامعتبر" });
        }
        const message = await messages.sendMessage(fastify, {
          senderId: socket.userId,
          recipientId: data.recipientId,
          content: data.content,
          replyTo: data.replyTo || null,
        });
        reply({ success: true, message });
      });

      on("message:read", { limit: [120, 60000] }, async (data, reply) => {
        if (isObjectId(data.messageId)) {
          await messages.markMessageRead(fastify, socket.userId, data.messageId);
        } else if (isObjectId(data.userId)) {
          await messages.markConversationRead(fastify, socket.userId, data.userId);
        }
        reply({ success: true });
      });

      on("typing:start", { limit: [60, 60000] }, async (data) => {
        const recipientId = data.recipientId;
        if (!isObjectId(recipientId) || !(await canMessage(recipientId))) return;

        messages.emitToUser(fastify, recipientId, "typing:start", {
          userId: socket.userId,
          username: socket.username,
        });
        const key = `${socket.userId}:${recipientId}`;
        clearTimeout(typingTimers.get(key));
        typingTimers.set(
          key,
          setTimeout(() => stopTyping(recipientId), TYPING_TIMEOUT_MS),
        );
      });

      on("typing:stop", { limit: [60, 60000] }, async (data) => {
        if (isObjectId(data.recipientId)) stopTyping(data.recipientId);
      });

      on("presence:watch", { limit: [30, 60000] }, async (data, reply) => {
        const ids = (Array.isArray(data.userIds) ? data.userIds : [])
          .filter(isObjectId)
          .slice(0, MAX_PRESENCE_WATCHES);

        for (const id of ids) {
          if (socket.data.watched.size >= MAX_PRESENCE_WATCHES) break;
          socket.data.watched.add(id);
          socket.join(`presence:${id}`);
        }
        reply({ success: true, online: ids.filter(isUserOnline) });
      });

      on("presence:unwatch", {}, async (data) => {
        for (const id of (Array.isArray(data.userIds) ? data.userIds : []).filter(isObjectId)) {
          socket.data.watched.delete(id);
          socket.leave(`presence:${id}`);
        }
      });

      on("user:active", { auth: false }, async () => {});

      on("post:like", { limit: [30, 60000] }, async (data) => {
        if (isObjectId(data.postId)) await likePost(fastify, socket.userId, data.postId);
      });

      on("comment:like", { limit: [30, 60000] }, async (data) => {
        if (isObjectId(data.commentId)) {
          await likeComment(fastify, socket.userId, data.commentId);
        }
      });

      on("post:join", { auth: false, limit: [60, 60000] }, async (data) => {
        if (!isObjectId(data.postId)) return;
        if (socket.data.postRooms.size >= MAX_POST_ROOMS) return;
        socket.data.postRooms.add(data.postId);
        socket.join(`post:${data.postId}`);
      });

      on("post:leave", { auth: false }, async (data) => {
        if (!isObjectId(data.postId)) return;
        socket.data.postRooms.delete(data.postId);
        socket.leave(`post:${data.postId}`);
      });

      on("notification:read", { limit: [20, 60000] }, async () => {
        await Notification.updateMany(
          { recipient: socket.userId, isRead: false },
          { isRead: true, readAt: new Date() },
        );
        socket.emit("notification:read_all", { success: true });
      });

      socket.on("error", (error) =>
        fastify.log.error({ err: error, socketId: socket.id }, "Socket error"),
      );

      socket.on("disconnect", () => {
        if (!socket.isAuthenticated) return;

        for (const [key, timer] of typingTimers) {
          if (key.startsWith(`${socket.userId}:`)) {
            clearTimeout(timer);
            typingTimers.delete(key);
            messages.emitToUser(fastify, key.split(":")[1], "typing:stop", {
              userId: socket.userId,
            });
          }
        }

        if (!isUserOnline(socket.userId)) {
          io().to(`presence:${socket.userId}`).emit("user:offline", {
            userId: socket.userId,
            username: socket.username,
          });
        }
      });
    });
  });

  fastify.addHook("onClose", async () => {
    try {
      await fastify.io.close();
    } catch (error) {
      fastify.log.error({ err: error }, "Error closing Socket.IO");
    }
  });
});
