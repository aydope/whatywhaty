const bcrypt = require("bcrypt");
const User = require("../models/User");
const crypto = require("crypto");
const { isUsernameTaken } = require("../utils/usernames");
const { sendPasswordResetEmail } = require("../services/mailer");
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

const RESET_TOKEN_EXPIRY = 60 * 30;

// Compared against when the email is unknown so both failures take the same time.
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 12);

const limit = (max, timeWindow) => ({
  config: { rateLimit: { max, timeWindow } },
});

const isDuplicateKey = (error) => error?.code === 11000;

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

const redirectIfAuthenticated = async (req, reply) => {
  const decoded = await req.server.verifyAccessToken(req.cookies?.accessToken);
  if (!decoded || decoded.expired) return;

  const exists = await User.exists({ _id: decoded.userId });
  if (exists) return reply.redirect("/");
};

module.exports = async function (fastify) {
  const authRequired = { preHandler: [fastify.authenticate] };
  const guestOnly = { preHandler: [redirectIfAuthenticated] };

  const startSession = async (reply, userId, version = 0) => {
    const tokens = fastify.generateTokens(userId, version);
    await fastify.addSession(userId, tokens.refreshTokenHash);
    fastify.setAuthCookies(reply, tokens.accessToken, tokens.refreshToken);
  };

  const sendFailure = (req, reply, error, label) => {
    if (error.statusCode === 400) {
      return reply
        .status(400)
        .send({ success: false, message: error.message });
    }

    req.log.error({ err: error }, label);
    return reply
      .status(500)
      .send({ success: false, message: MSG.SERVER_ERROR });
  };

  fastify.get("/register", guestOnly, (req, reply) => {
    return reply.view("auth/register.ejs", {
      title: "ثبت‌نام · واتی‌واتی",
      user: null,
    });
  });

  fastify.post("/register", limit(10, "1 hour"), async (req, reply) => {
    try {
      const { username, displayName, email, password } = validateRequest(
        registerSchema,
        req.body,
      );

      const exists =
        (await User.exists({ email })) || (await isUsernameTaken(username));
      if (exists) {
        return reply
          .status(409)
          .send({ success: false, message: MSG.USER_EXISTS });
      }

      const user = await User.create({
        username,
        displayName: displayName || "",
        email,
        password,
      });
      await startSession(reply, user._id);

      return reply.status(201).send({
        success: true,
        message: MSG.REGISTER_SUCCESS,
        redirect: "/",
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        return reply
          .status(409)
          .send({ success: false, message: MSG.USER_EXISTS });
      }
      return sendFailure(req, reply, error, "Register error");
    }
  });

  fastify.get("/login", guestOnly, (req, reply) => {
    return reply.view("auth/login.ejs", {
      title: "ورود · واتی‌واتی",
      user: null,
    });
  });

  fastify.post("/login", limit(10, "15 minutes"), async (req, reply) => {
    try {
      const { email, password } = validateRequest(loginSchema, req.body);

      const user = await User.findOne({ email })
        .select("password tokenVersion")
        .lean();
      const isPasswordValid = await bcrypt.compare(
        password,
        user?.password || DUMMY_HASH,
      );

      if (!user || !isPasswordValid) {
        return reply
          .status(401)
          .send({ success: false, message: MSG.INVALID_CREDENTIALS });
      }

      await startSession(reply, user._id, user.tokenVersion);

      return reply.status(200).send({
        success: true,
        message: MSG.LOGIN_SUCCESS,
        redirect: "/",
      });
    } catch (error) {
      return sendFailure(req, reply, error, "Login error");
    }
  });

  fastify.post("/refresh", limit(60, "1 minute"), async (req, reply) => {
    try {
      const refreshToken = req.cookies?.refreshToken;

      if (!refreshToken) {
        return reply
          .status(401)
          .send({ success: false, message: MSG.REFRESH_REQUIRED });
      }

      const decoded = await fastify.verifyRefreshToken(refreshToken);

      if (!decoded || decoded.expired) {
        fastify.clearAuthCookies(reply);
        return reply.status(401).send({
          success: false,
          message: decoded?.expired ? MSG.REFRESH_EXPIRED : MSG.REFRESH_INVALID,
        });
      }

      const { accessToken } = fastify.generateTokens(
        decoded.userId,
        decoded.version,
      );
      fastify.setAuthCookies(reply, accessToken);

      return reply.status(200).send({ success: true, accessToken });
    } catch (error) {
      return sendFailure(req, reply, error, "Refresh token error");
    }
  });

  fastify.post("/logout", authRequired, async (req, reply) => {
    try {
      const { accessToken, refreshToken } = req.cookies || {};

      await fastify.blacklistAccessToken(accessToken);
      if (refreshToken) {
        const hash = crypto
          .createHash("sha256")
          .update(refreshToken)
          .digest("hex");
        await fastify.removeSession(req.user._id, hash);
      }

      fastify.clearAuthCookies(reply);
      return reply
        .status(200)
        .send({ success: true, message: MSG.LOGOUT_SUCCESS });
    } catch (error) {
      return sendFailure(req, reply, error, "Logout error");
    }
  });

  fastify.put(
    "/change-password",
    { ...authRequired, ...limit(10, "15 minutes") },
    async (req, reply) => {
      try {
        const { currentPassword, newPassword } = validateRequest(
          changePasswordSchema,
          req.body,
        );

        const user = await User.findById(req.user._id).select("+password");
        if (!(await user.comparePassword(currentPassword))) {
          return reply
            .status(400)
            .send({ success: false, message: MSG.PASSWORD_INCORRECT });
        }

        user.password = newPassword;
        user.sessions = [];
        await user.save();

        // Every other device is signed out; this one gets a fresh session.
        await fastify.blacklistAccessToken(req.cookies?.accessToken);
        await startSession(reply, user._id, user.tokenVersion);

        return reply
          .status(200)
          .send({ success: true, message: MSG.PASSWORD_CHANGED });
      } catch (error) {
        return sendFailure(req, reply, error, "Change password error");
      }
    },
  );

  fastify.post(
    "/forgot-password",
    limit(5, "1 hour"),
    async (req, reply) => {
      try {
        const { email } = validateRequest(forgotPasswordSchema, req.body);
        const user = await User.findOne({ email }).select("_id email username");

        if (user) {
          const resetToken = crypto.randomBytes(32).toString("hex");
          user.resetPasswordToken = crypto
            .createHash("sha256")
            .update(resetToken)
            .digest("hex");
          user.resetPasswordExpires = Date.now() + RESET_TOKEN_EXPIRY * 1000;
          await user.save();

          const base =
            process.env.APP_URL || `${req.protocol}://${req.headers.host}`;
          await sendPasswordResetEmail(fastify, {
            to: user.email,
            username: user.username,
            link: `${base}/auth/reset-password?token=${resetToken}`,
          }).catch((error) =>
            req.log.error({ err: error }, "Password reset email failed"),
          );
        }

        // The same answer is returned whether or not the email exists, and the
        // reset link is only ever delivered by email.
        return reply
          .status(200)
          .send({ success: true, message: MSG.RESET_EMAIL_SENT });
      } catch (error) {
        return sendFailure(req, reply, error, "Forgot password error");
      }
    },
  );

  fastify.get("/reset-password", async (req, reply) => {
    const view = (token, error) =>
      reply.view("auth/reset-password.ejs", {
        title: "بازنشانی رمز · واتی‌واتی",
        token,
        error,
      });

    try {
      const { token } = req.query;
      if (typeof token !== "string" || !token) {
        return reply.redirect("/auth/login");
      }

      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const valid = await User.exists({
        resetPasswordToken: tokenHash,
        resetPasswordExpires: { $gt: Date.now() },
      });

      return valid ? view(token, null) : view(null, MSG.RESET_INVALID);
    } catch (error) {
      req.log.error({ err: error }, "Reset password page error");
      return view(null, MSG.SERVER_ERROR);
    }
  });

  fastify.post(
    "/reset-password",
    limit(10, "1 hour"),
    async (req, reply) => {
      try {
        const { token, password } = validateRequest(
          resetPasswordSchema,
          req.body,
        );
        const tokenHash = crypto
          .createHash("sha256")
          .update(token)
          .digest("hex");

        const user = await User.findOne({
          resetPasswordToken: tokenHash,
          resetPasswordExpires: { $gt: Date.now() },
        }).select("+resetPasswordToken +resetPasswordExpires +sessions");

        if (!user) {
          return reply
            .status(400)
            .send({ success: false, message: MSG.RESET_INVALID });
        }

        user.password = password;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        user.sessions = [];
        await user.save();

        fastify.clearAuthCookies(reply);
        return reply.status(200).send({
          success: true,
          message: MSG.RESET_SUCCESS,
          redirect: "/auth/login",
        });
      } catch (error) {
        return sendFailure(req, reply, error, "Reset password error");
      }
    },
  );
};
