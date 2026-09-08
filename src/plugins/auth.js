const fp = require("fastify-plugin");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

module.exports = fp(async (fastify, opts) => {
  const ACCESS_MAX_AGE = 15 * 60;
  const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;
  const USER_SELECT = "-password -refreshToken";

  fastify.decorate("generateTokens", (userId) => {
    const accessToken = jwt.sign(
      { userId: userId.toString() },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || "15m" },
    );
    const refreshToken = jwt.sign(
      { userId: userId.toString() },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || "7d" },
    );
    const refreshTokenHash = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");

    return { accessToken, refreshToken, refreshTokenHash };
  });

  fastify.decorate("verifyAccessToken", async (token) => {
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      const blacklisted = await fastify.redis.get(`blacklist:${token}`);
      return blacklisted ? null : decoded;
    } catch (err) {
      return err.name === "TokenExpiredError" ? { expired: true } : null;
    }
  });

  fastify.decorate("verifyRefreshToken", async (token) => {
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);

      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const User = require("../models/User");
      const user = await User.findById(decoded.userId).select("refreshToken");

      if (!user) return null;
      if (!user.refreshToken) return null;
      if (user.refreshToken !== tokenHash) return null;

      return { userId: decoded.userId };
    } catch (err) {
      if (err.name === "TokenExpiredError") return { expired: true };
      return null;
    }
  });

  const setAuthCookies = (reply, accessToken, refreshToken) => {
    const isProduction = process.env.NODE_ENV === "production";
    const base = {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
    };

    reply.setCookie("accessToken", accessToken, {
      ...base,
      maxAge: ACCESS_MAX_AGE,
    });
    reply.setCookie("refreshToken", refreshToken, {
      ...base,
      maxAge: REFRESH_MAX_AGE,
    });
  };

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

  fastify.decorate("authenticate", async (req, reply) => {
    try {
      const token =
        req.cookies?.accessToken ||
        req.headers.authorization?.replace("Bearer ", "");

      if (!token) return sendUnauthorized(req, reply);

      const decoded = await fastify.verifyAccessToken(token);
      if (!decoded) return sendUnauthorized(req, reply);

      if (decoded.expired) {
        const refreshToken = req.cookies?.refreshToken;
        if (!refreshToken) return sendUnauthorized(req, reply);

        const refreshDecoded = await fastify.verifyRefreshToken(refreshToken);
        if (!refreshDecoded || refreshDecoded.expired)
          return sendUnauthorized(req, reply);

        const User = require("../models/User");
        const user = await User.findById(refreshDecoded.userId).select(
          USER_SELECT,
        );
        if (!user) return sendUnauthorized(req, reply);

        const tokens = fastify.generateTokens(user._id);
        user.refreshToken = tokens.refreshTokenHash;
        await user.save();

        await fastify.redis.set(
          `blacklist:${refreshToken}`,
          "1",
          "EX",
          REFRESH_MAX_AGE,
        );
        setAuthCookies(reply, tokens.accessToken, tokens.refreshToken);

        req.user = user;
        return;
      }

      const User = require("../models/User");
      const user = await User.findById(decoded.userId).select(USER_SELECT);
      if (!user) return sendUnauthorized(req, reply);

      req.user = user;
    } catch (error) {
      req.log.error({ err: error }, "Authenticate error");
      return sendUnauthorized(req, reply);
    }
  });

  fastify.decorate("authenticateSilent", async (req) => {
    try {
      const token =
        req.cookies?.accessToken ||
        req.headers.authorization?.replace("Bearer ", "");
      if (!token) return null;

      const decoded = await fastify.verifyAccessToken(token);
      if (!decoded || decoded.expired) return null;

      const User = require("../models/User");
      const user = await User.findById(decoded.userId).select(USER_SELECT);
      if (!user) return null;

      req.user = user;
      return user;
    } catch {
      return null;
    }
  });

  fastify.decorate("authenticateAdmin", async (req, reply) => {
    await fastify.authenticate(req, reply);
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
    try {
      await fastify.authenticateSilent(req);
      return !!req.user;
    } catch {
      return false;
    }
  });
});
