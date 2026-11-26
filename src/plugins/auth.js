const fp = require("fastify-plugin");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");

const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;
const MAX_SESSIONS = 5;
const USER_SELECT = "-password";

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

module.exports = fp(async (fastify) => {
  const isProduction = process.env.NODE_ENV === "production";
  const cookieBase = {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
  };

  const redisReady = () => fastify.redis?.status === "ready";

  fastify.decorate("generateTokens", (userId, version = 0) => {
    const accessToken = jwt.sign(
      { userId: userId.toString(), v: version },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || "15m" },
    );
    const refreshToken = jwt.sign(
      { userId: userId.toString(), v: version },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || "7d" },
    );

    return { accessToken, refreshToken, refreshTokenHash: sha256(refreshToken) };
  });

  // The access cookie lives as long as the refresh cookie on purpose: once the
  // JWT inside it expires the server still receives it and can renew it.
  fastify.decorate("setAuthCookies", (reply, accessToken, refreshToken) => {
    reply.setCookie("accessToken", accessToken, {
      ...cookieBase,
      maxAge: REFRESH_MAX_AGE,
    });
    if (refreshToken) {
      reply.setCookie("refreshToken", refreshToken, {
        ...cookieBase,
        maxAge: REFRESH_MAX_AGE,
      });
    }
  });

  fastify.decorate("clearAuthCookies", (reply) => {
    reply.clearCookie("accessToken", cookieBase);
    reply.clearCookie("refreshToken", cookieBase);
  });

  fastify.decorate("addSession", async (userId, hash) => {
    await User.updateOne(
      { _id: userId },
      {
        $push: {
          sessions: { $each: [{ hash, createdAt: new Date() }], $slice: -MAX_SESSIONS },
        },
      },
    );
  });

  fastify.decorate("removeSession", (userId, hash) =>
    User.updateOne({ _id: userId }, { $pull: { sessions: { hash } } }),
  );

  fastify.decorate("revokeAllSessions", (userId) =>
    User.updateOne({ _id: userId }, { $set: { sessions: [] } }),
  );

  // Access tokens revoked at logout are kept in Redis until they expire. The
  // lookup is best effort: when Redis is down the token is still accepted.
  fastify.decorate("blacklistAccessToken", async (token) => {
    if (!token || !redisReady()) return;
    try {
      const { exp } = jwt.decode(token) || {};
      const ttl = exp ? exp - Math.floor(Date.now() / 1000) : 900;
      if (ttl > 0) await fastify.redis.set(`revoked:${sha256(token)}`, "1", "EX", ttl);
    } catch (error) {
      fastify.log.warn({ err: error }, "Could not revoke access token");
    }
  });

  const isRevoked = async (token) => {
    if (!redisReady()) return false;
    try {
      return !!(await fastify.redis.get(`revoked:${sha256(token)}`));
    } catch (error) {
      fastify.log.warn({ err: error }, "Revocation lookup failed");
      return false;
    }
  };

  fastify.decorate("verifyAccessToken", async (token) => {
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET, {
        algorithms: ["HS256"],
      });
      return (await isRevoked(token)) ? null : decoded;
    } catch (err) {
      return err.name === "TokenExpiredError" ? { expired: true } : null;
    }
  });

  fastify.decorate("verifyRefreshToken", async (token) => {
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET, {
        algorithms: ["HS256"],
      });
      const owner = await User.findOne({
        _id: decoded.userId,
        "sessions.hash": sha256(token),
      })
        .select("tokenVersion")
        .lean();
      return owner
        ? { userId: decoded.userId, version: owner.tokenVersion || 0 }
        : null;
    } catch (err) {
      if (err.name === "TokenExpiredError") return { expired: true };
      return null;
    }
  });

  const isApiRequest = (req) =>
    req.headers.accept?.includes("application/json") ||
    req.url.startsWith("/api/") ||
    req.headers["x-requested-with"] === "XMLHttpRequest";

  const sendUnauthorized = (req, reply) => {
    if (isApiRequest(req)) {
      return reply.status(401).send({
        success: false,
        message: "لطفاً ابتدا وارد حساب کاربری خود شوید",
        code: "UNAUTHORIZED",
      });
    }
    return reply.redirect("/auth/login");
  };

  const getToken = (req) =>
    req.cookies?.accessToken ||
    req.headers.authorization?.replace(/^Bearer /, "");

  const issuedForOldPassword = (decoded, user) =>
    (decoded.v || 0) !== (user.tokenVersion || 0);

  const loadUser = async (decoded) => {
    const user = await User.findById(decoded.userId).select(USER_SELECT);
    if (!user || issuedForOldPassword(decoded, user)) return null;
    return user;
  };

  // Renews the access token from the refresh cookie. The refresh token itself
  // is not rotated, so parallel requests cannot invalidate each other.
  const refreshFromCookie = async (req, reply) => {
    const refreshToken = req.cookies?.refreshToken;
    const refreshed = await fastify.verifyRefreshToken(refreshToken);
    if (!refreshed || refreshed.expired) return null;

    const user = await User.findById(refreshed.userId).select(USER_SELECT);
    if (!user) return null;

    const { accessToken } = fastify.generateTokens(user._id, user.tokenVersion);
    fastify.setAuthCookies(reply, accessToken);
    return user;
  };

  fastify.decorate("authenticate", async (req, reply) => {
    try {
      const decoded = await fastify.verifyAccessToken(getToken(req));
      let user = decoded && !decoded.expired ? await loadUser(decoded) : null;

      if (!user) user = await refreshFromCookie(req, reply);
      if (!user) return sendUnauthorized(req, reply);

      req.user = user;
    } catch (error) {
      req.log.error({ err: error }, "Authenticate error");
      return sendUnauthorized(req, reply);
    }
  });

  fastify.decorate("authenticateSilent", async (req) => {
    try {
      const decoded = await fastify.verifyAccessToken(getToken(req));
      if (!decoded || decoded.expired) return null;

      const user = await loadUser(decoded);
      if (user) req.user = user;
      return user;
    } catch {
      return null;
    }
  });

  fastify.decorate("authenticateAdmin", async (req, reply) => {
    await fastify.authenticate(req, reply);
    if (reply.sent) return reply;

    if (req.user?.role !== "admin") {
      if (isApiRequest(req)) {
        return reply.status(403).send({
          success: false,
          message: "این بخش تنها برای مدیران سیستم قابل دسترسی است",
          code: "ADMIN_ONLY",
        });
      }
      return reply.redirect("/");
    }
  });

  fastify.decorate("isAuthenticated", async (req) => {
    await fastify.authenticateSilent(req);
    return !!req.user;
  });
});
