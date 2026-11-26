require("dotenv").config();

const path = require("path");
const mongoose = require("mongoose");
const Fastify = require("fastify");

const User = require("./models/User");

const isProduction = process.env.NODE_ENV === "production";

const requiredSecrets = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "COOKIE_SECRET"];

const assertEnvironment = () => {
  const missing = ["MONGODB_URI", ...requiredSecrets].filter(
    (name) => !process.env[name],
  );
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }

  if (isProduction) {
    const weak = requiredSecrets.filter((name) => process.env[name].length < 32);
    if (weak.length) {
      throw new Error(`Secrets shorter than 32 characters: ${weak.join(", ")}`);
    }
  }
};

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
  : null;

const fastify = Fastify({
  logger: isProduction
    ? true
    : {
        level: "info",
        transport: {
          target: "pino-pretty",
          options: {
            ignore: "pid,hostname",
            translateTime: "HH:MM:ss Z",
          },
        },
      },
  trustProxy: true,
  pluginTimeout: 10000,
  bodyLimit: 1024 * 10,
  connectionTimeout: 30000,
  keepAliveTimeout: 60000,
  routerOptions: { maxParamLength: 1000 },
});

const registerPlugins = async () => {
  await fastify.register(require("@fastify/cors"), {
    origin: allowedOrigins || !isProduction,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: true,
  });

  await fastify.register(require("@fastify/helmet"), {
    // Pages still rely on inline scripts and CDN assets, so script and style
    // sources are not restricted yet. The remaining directives block
    // clickjacking, <base> injection, plugins and form hijacking.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["*", "data:", "blob:", "'unsafe-inline'", "'unsafe-eval'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    hsts: isProduction ? { maxAge: 15552000 } : false,
  });

  await fastify.register(require("@fastify/compress"), { threshold: 1024 });

  await fastify.register(require("@fastify/rate-limit"), {
    max: 3000,
    timeWindow: "10 minute",
    // With trustProxy enabled req.ip is already the client address, whereas
    // the raw X-Forwarded-For header can be set to anything by the client.
    keyGenerator: (req) => req.ip,
    allowList: (req) =>
      req.url.startsWith("/public/") || req.url === "/health",
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      success: false,
      message: "تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید",
      retryAfter: context.after,
    }),
  });

  await fastify.register(require("@fastify/cookie"), {
    secret: process.env.COOKIE_SECRET,
  });

  await fastify.register(require("@fastify/formbody"));

  await fastify.register(require("@fastify/static"), {
    root: path.join(__dirname, "../public"),
    prefix: "/public/",
    maxAge: isProduction ? "1h" : 0,
  });

  await fastify.register(require("@fastify/view"), {
    engine: { ejs: require("ejs") },
    root: path.join(__dirname, "views"),
    layout: false,
    includeViewExtension: true,
    options: { cache: isProduction },
  });

  // Cookies are SameSite=Lax already; this also rejects state-changing
  // requests that a browser tagged with a foreign Origin.
  fastify.addHook("onRequest", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;

    const origin = req.headers.origin;
    if (!origin) return;

    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }

    if (host === req.headers.host || allowedOrigins?.includes(origin)) return;

    return reply.status(403).send({
      success: false,
      message: "درخواست از مبدا نامعتبر ارسال شده است",
    });
  });

  const plugins = [
    ["./plugins/redis"],
    ["./plugins/auth"],
    ["./plugins/socket"],
    ["./plugins/rbac"],
    ["./routes/auth", { prefix: "/auth" }],
    ["./routes/posts", { prefix: "/posts" }],
    ["./routes/comments", { prefix: "/comments" }],
    ["./routes/users", { prefix: "/users" }],
    ["./routes/messages", { prefix: "/messages" }],
    ["./routes/admin", { prefix: "/admin" }],
  ];

  for (const [pluginPath, options = {}] of plugins) {
    await fastify.register(require(pluginPath), options);
  }

  const auth = { preHandler: [fastify.authenticate] };

  fastify.get("/health", async () => ({ status: "ok" }));

  fastify.get("/", auth, async (req, reply) =>
    reply.view("home.ejs", { user: req.user }),
  );

  fastify.get("/explore", auth, async (req, reply) =>
    reply.view("explore.ejs", { user: req.user }),
  );

  fastify.get("/@:username", auth, async (req, reply) => {
    try {
      const isOwnProfile =
        req.user.username.toLowerCase() === req.params.username.toLowerCase();

      // Email and the block list belong to the account owner only.
      const profileUser = isOwnProfile
        ? req.user
        : await User.findOne({ username: req.params.username })
            .collation({ locale: "en", strength: 2 })
            .select("-email -blockedUsers")
            .lean();

      if (!profileUser) {
        return reply.status(404).view("404.ejs", { user: req.user });
      }

      const isBlocked = isOwnProfile
        ? false
        : !!(await User.exists({
            _id: profileUser._id,
            blockedUsers: req.user._id,
          }));

      return reply.view("profile.ejs", {
        profileUser,
        currentUser: req.user,
        isBlocked,
      });
    } catch (error) {
      req.log.error(
        { err: error, username: req.params.username },
        "Profile view error",
      );
      return reply
        .status(500)
        .send({ success: false, message: "خطا در بارگذاری پروفایل" });
    }
  });
};

fastify.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode || 500;

  if (statusCode >= 500) {
    request.log.error({
      err: error,
      url: request.url,
      method: request.method,
      ip: request.ip,
    });
  }

  if (error.validation) {
    return reply.status(400).send({
      success: false,
      message: "Validation Error",
      errors: error.validation.map((e) => ({
        field: e.instancePath || e.params?.missingProperty,
        message: e.message,
      })),
    });
  }

  if (statusCode === 429) {
    return reply.status(429).send({
      success: false,
      message: error.message,
      retryAfter: error.retryAfter,
    });
  }

  if (statusCode < 500) {
    return reply.status(statusCode).send({
      success: false,
      message: statusCode === 404 ? "یافت نشد" : "درخواست نامعتبر است",
    });
  }

  return reply.status(statusCode).send({
    success: false,
    message: isProduction ? "Internal Server Error" : error.message,
    ...(isProduction ? {} : { stack: error.stack }),
  });
});

fastify.setNotFoundHandler(async (req, reply) => {
  if (req.headers.accept?.includes("application/json")) {
    return reply.status(404).send({
      success: false,
      message: "این صفحه وجود نداره",
    });
  }
  return reply.status(404).view("404.ejs", { user: null });
});

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      family: 4,
    });
    fastify.log.info("MongoDB connected");
  } catch (error) {
    fastify.log.error(`MongoDB connection failed: ${error.message}`);
    process.exit(1);
  }
};

let shuttingDown = false;

const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info(`${signal} received, shutting down`);

  const forceExit = setTimeout(() => {
    fastify.log.error("Forced shutdown after 10s timeout");
    process.exit(1);
  }, 10000);
  forceExit.unref();

  try {
    // Closing fastify also runs the Redis and Socket.IO onClose hooks.
    await fastify.close();
    await mongoose.connection.close();
    process.exit(exitCode);
  } catch (error) {
    fastify.log.error(`Shutdown error: ${error.message}`);
    process.exit(1);
  }
};

const start = async () => {
  assertEnvironment();
  await connectDB();
  await registerPlugins();
  await fastify.listen({
    port: process.env.PORT || 3000,
    host: "0.0.0.0",
  });
};

["SIGTERM", "SIGINT"].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});

// A rejected promise is logged and the process keeps serving; only a truly
// uncaught exception, where state may be corrupt, restarts the process.
process.on("unhandledRejection", (error) => {
  fastify.log.error({ err: error }, "Unhandled rejection");
});

process.on("uncaughtException", (error) => {
  fastify.log.error({ err: error }, "Uncaught exception");
  shutdown("UNCAUGHT_EXCEPTION", 1);
});

start().catch((error) => {
  fastify.log.error(error);
  process.exit(1);
});
