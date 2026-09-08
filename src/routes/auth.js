const bcrypt = require("bcrypt");
const User = require("../models/User");
const crypto = require("crypto");
const {
  registerSchema,
  loginSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} = require("../validators/auth");

const MSG = {
  INVALID_CREDENTIALS: "ایمیل یا رمز عبور اشتباه است",
  USER_EXISTS: "این نام کاربری یا ایمیل قبلا ثبت شده است",
  REFRESH_REQUIRED: "توکن رفرش الزامی است",
  REFRESH_INVALID: "توکن رفرش نامعتبر است",
  REFRESH_EXPIRED: "توکن رفرش منقضی شده است",
  LOGIN_SUCCESS: "ورود موفقیت‌آمیز بود",
  REGISTER_SUCCESS: "ثبت‌نام با موفقیت انجام شد",
  LOGOUT_SUCCESS: "خروج موفقیت‌آمیز بود",
  PASSWORD_CHANGED: "رمز عبور با موفقیت تغییر کرد",
  PASSWORD_INCORRECT: "رمز عبور فعلی اشتباه است",
  RESET_EMAIL_SENT: "لینک بازنشانی رمز عبور به ایمیل شما ارسال شد",
  RESET_SUCCESS: "رمز عبور با موفقیت بازنشانی شد",
  RESET_INVALID: "لینک بازنشانی نامعتبر یا منقضی شده است",
  USER_NOT_FOUND: "کاربری با این ایمیل یافت نشد",
  SERVER_ERROR: "خطایی رخ داد. لطفاً دوباره تلاش کنید",
};

const ACCESS_MAX_AGE = 15 * 60;
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;
const RESET_TOKEN_EXPIRY = 60 * 5;

const setCookies = (reply, accessToken, refreshToken) => {
  const secure = process.env.NODE_ENV === "production";
  const base = { httpOnly: true, secure, sameSite: "lax", path: "/" };

  reply.setCookie("accessToken", accessToken, {
    ...base,
    maxAge: ACCESS_MAX_AGE,
  });

  reply.setCookie("refreshToken", refreshToken, {
    ...base,
    maxAge: REFRESH_MAX_AGE,
  });
};

const clearCookies = (reply) => {
  reply.clearCookie("accessToken", { path: "/" });
  reply.clearCookie("refreshToken", { path: "/" });
};

const blacklistToken = async (fastify, token) => {
  if (!token) return;

  try {
    await fastify.redis.set(`blacklist:${token}`, "1", "EX", REFRESH_MAX_AGE);
  } catch (error) {
    fastify.log.error({ error }, "Token blacklist error");
  }
};

const validateRequest = (schema, body) => {
  const { error, value } = schema.validate(body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    throw Object.assign(new Error(error.details[0].message), {
      statusCode: 400,
    });
  }

  return value;
};

const saveRefreshToken = async (userId, tokenHash) => {
  try {
    const user = await User.findByIdAndUpdate(
      userId,
      { refreshToken: tokenHash },
      { returnDocument: "after", runValidators: true },
    ).select("refreshToken");

    return user?.refreshToken === tokenHash;
  } catch (error) {
    return false;
  }
};

const redirectIfAuthenticated = async (req, reply) => {
  try {
    const token = req.cookies?.accessToken;
    if (!token) return;

    const decoded = await req.server.verifyAccessToken(token);
    if (decoded && !decoded.expired) {
      return reply.redirect("/");
    }
  } catch (error) {}
};

module.exports = async function (fastify) {
  const authRequired = { preHandler: [fastify.authenticate] };
  const guestOnly = { preHandler: [redirectIfAuthenticated] };

  fastify.get("/register", guestOnly, (req, reply) => {
    return reply.view("auth/register.ejs", {
      title: "ثبت‌نام · واتی‌واتی",
      user: null,
    });
  });

  fastify.post("/register", async (req, reply) => {
    try {
      const { username, email, password } = validateRequest(
        registerSchema,
        req.body,
      );

      const userExists = await User.findOne({
        $or: [{ email }, { username }],
      })
        .select("_id")
        .lean();

      if (userExists) {
        return reply.status(409).send({
          success: false,
          message: MSG.USER_EXISTS,
        });
      }

      const user = await User.create({ username, email, password });
      const tokens = fastify.generateTokens(user._id);

      await saveRefreshToken(user._id, tokens.refreshTokenHash);
      setCookies(reply, tokens.accessToken, tokens.refreshToken);

      return reply.status(201).send({
        success: true,
        message: MSG.REGISTER_SUCCESS,
        redirect: "/",
      });
    } catch (error) {
      if (error.statusCode === 400) {
        return reply.status(400).send({
          success: false,
          message: error.message,
        });
      }

      fastify.log.error({ error }, "Register error");
      return reply.status(500).send({
        success: false,
        message: MSG.SERVER_ERROR,
      });
    }
  });

  fastify.get("/login", guestOnly, (req, reply) => {
    return reply.view("auth/login.ejs", {
      title: "ورود · واتی‌واتی",
      user: null,
    });
  });

  fastify.post("/login", async (req, reply) => {
    try {
      const { email, password } = validateRequest(loginSchema, req.body);

      const user = await User.findOne({ email }).select("password").lean();

      if (!user) {
        return reply.status(401).send({
          success: false,
          message: MSG.INVALID_CREDENTIALS,
        });
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        return reply.status(401).send({
          success: false,
          message: MSG.INVALID_CREDENTIALS,
        });
      }

      const tokens = fastify.generateTokens(user._id);
      await saveRefreshToken(user._id, tokens.refreshTokenHash);
      setCookies(reply, tokens.accessToken, tokens.refreshToken);

      return reply.status(200).send({
        success: true,
        message: MSG.LOGIN_SUCCESS,
        redirect: "/",
      });
    } catch (error) {
      if (error.statusCode === 400) {
        return reply.status(400).send({
          success: false,
          message: error.message,
        });
      }

      fastify.log.error({ error }, "Login error");
      return reply.status(500).send({
        success: false,
        message: MSG.SERVER_ERROR,
      });
    }
  });

  fastify.post("/refresh", async (req, reply) => {
    try {
      const refreshToken = req.cookies?.refreshToken;

      if (!refreshToken) {
        return reply.status(401).send({
          success: false,
          message: MSG.REFRESH_REQUIRED,
        });
      }

      const decoded = await fastify.verifyRefreshToken(refreshToken);

      if (!decoded || decoded.expired) {
        clearCookies(reply);
        const message = decoded?.expired
          ? MSG.REFRESH_EXPIRED
          : MSG.REFRESH_INVALID;

        return reply.status(401).send({
          success: false,
          message,
        });
      }

      const tokens = fastify.generateTokens(decoded.userId);
      const saved = await saveRefreshToken(
        decoded.userId,
        tokens.refreshTokenHash,
      );

      if (!saved) {
        clearCookies(reply);
        return reply.status(500).send({
          success: false,
          message: MSG.SERVER_ERROR,
        });
      }

      setCookies(reply, tokens.accessToken, tokens.refreshToken);

      return reply.status(200).send({
        success: true,
        accessToken: tokens.accessToken,
      });
    } catch (error) {
      fastify.log.error({ error }, "Refresh token error");
      return reply.status(500).send({
        success: false,
        message: MSG.SERVER_ERROR,
      });
    }
  });

  fastify.post("/logout", authRequired, async (req, reply) => {
    try {
      const refreshToken = req.cookies?.refreshToken;

      if (refreshToken) {
        await blacklistToken(fastify, refreshToken);
        await User.updateOne(
          { _id: req.user?._id },
          { refreshToken: null },
        ).catch(() => {});
      }

      clearCookies(reply);

      return reply.status(200).send({
        success: true,
        message: MSG.LOGOUT_SUCCESS,
      });
    } catch (error) {
      fastify.log.error({ error }, "Logout error");
      return reply.status(500).send({
        success: false,
        message: MSG.SERVER_ERROR,
      });
    }
  });

  fastify.put("/change-password", authRequired, async (req, reply) => {
    try {
      const { currentPassword, newPassword } = validateRequest(
        changePasswordSchema,
        req.body,
      );

      const user = await User.findById(req.user._id).select("+password");
      const isPasswordValid = await user.comparePassword(currentPassword);

      if (!isPasswordValid) {
        return reply.status(400).send({
          success: false,
          message: MSG.PASSWORD_INCORRECT,
        });
      }

      user.password = newPassword;
      await user.save();

      return reply.status(200).send({
        success: true,
        message: MSG.PASSWORD_CHANGED,
      });
    } catch (error) {
      if (error.statusCode === 400) {
        return reply.status(400).send({
          success: false,
          message: error.message,
        });
      }

      fastify.log.error({ error }, "Change password error");
      return reply.status(500).send({
        success: false,
        message: MSG.SERVER_ERROR,
      });
    }
  });

  fastify.post("/forgot-password", async (req, reply) => {
    try {
      const { email } = validateRequest(forgotPasswordSchema, req.body);

      const user = await User.findOne({ email }).select("_id email username");

      if (!user) {
        return reply.status(200).send({
          success: true,
          message: MSG.RESET_EMAIL_SENT,
        });
      }

      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetTokenHash = crypto
        .createHash("sha256")
        .update(resetToken)
        .digest("hex");

      user.resetPasswordToken = resetTokenHash;
      user.resetPasswordExpires = Date.now() + RESET_TOKEN_EXPIRY * 1000;
      await user.save();

      return reply.status(200).send({
        success: true,
        message: MSG.RESET_EMAIL_SENT,
        redirect: `/auth/reset-password?token=${resetToken}`,
      });
    } catch (error) {
      if (error.statusCode === 400) {
        return reply.status(400).send({
          success: false,
          message: error.message,
        });
      }

      fastify.log.error({ error }, "Forgot password error");
      return reply.status(500).send({
        success: false,
        message: MSG.SERVER_ERROR,
      });
    }
  });

  fastify.get("/reset-password", async (req, reply) => {
    try {
      const { token } = req.query;

      if (!token && req.user) return reply.redirect("/");
      if (!token) return reply.redirect("/auth/login");

      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      const user = await User.findOne({
        resetPasswordToken: tokenHash,
        resetPasswordExpires: { $gt: Date.now() },
      }).select("_id");

      if (!user) {
        return reply.view("auth/reset-password.ejs", {
          title: "بازنشانی رمز · واتی‌واتی",
          token: null,
          error: MSG.RESET_INVALID,
        });
      }

      return reply.view("auth/reset-password.ejs", {
        title: "بازنشانی رمز · واتی‌واتی",
        token,
        error: null,
      });
    } catch (error) {
      fastify.log.error({ error }, "Reset password page error");

      return reply.view("auth/reset-password.ejs", {
        title: "بازنشانی رمز · واتی‌واتی",
        token: null,
        error: "خطایی رخ داد. لطفاً دوباره تلاش کنید",
      });
    }
  });

  fastify.post("/reset-password", async (req, reply) => {
    try {
      const { token, password } = validateRequest(
        resetPasswordSchema,
        req.body,
      );

      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      const user = await User.findOne({
        resetPasswordToken: tokenHash,
        resetPasswordExpires: { $gt: Date.now() },
      }).select("+resetPasswordToken +resetPasswordExpires");

      if (!user) {
        return reply.status(400).send({
          success: false,
          message: MSG.RESET_INVALID,
        });
      }

      user.password = password;
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      user.refreshToken = null;
      await user.save();

      await fastify.redis.set(
        `user:${user._id}:logout`,
        "1",
        "EX",
        REFRESH_MAX_AGE,
      );

      clearCookies(reply);

      return reply.status(200).send({
        success: true,
        message: MSG.RESET_SUCCESS,
        redirect: "/auth/login",
      });
    } catch (error) {
      if (error.statusCode === 400) {
        return reply.status(400).send({
          success: false,
          message: error.message,
        });
      }

      fastify.log.error({ error }, "Reset password error");
      return reply.status(500).send({
        success: false,
        message: MSG.SERVER_ERROR,
      });
    }
  });
};
