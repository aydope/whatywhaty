require("dotenv").config();

const path = require("path");
const mongoose = require("mongoose");
const Fastify = require("fastify");

const User = require("./models/User");

const isProduction = process.env.NODE_ENV === "production";

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
  maxParamLength: 1000,
});

const registerPlugins = async () => {
  await fastify.register(require("@fastify/cors"), {
    origin: process.env.CORS_ORIGIN?.split(",") || true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: true,
  });

  await fastify.register(require("@fastify/helmet"), {
    contentSecurityPolicy: false,
    hsts: false,
  });

  await fastify.register(require("@fastify/rate-limit"), {
    max: 3000,
    timeWindow: "10 minute",
    keyGenerator: (req) => {
      const ip =
        req.headers["x-forwarded-for"] ||
        req.ip ||
        req.connection.remoteAddress;
      const userAgent = req.headers["user-agent"] || "";
      return `${ip}:${userAgent.substring(0, 20)}`;
    },
    skip: (req) =>
      req.ip === "127.0.0.1" ||
      req.url.startsWith("/public/") ||
      req.url === "/health" ||
      req.url.startsWith("/socket.io/"),
    errorResponseBuilder: (req, context) => ({
      success: false,
      message: "Too many requests. Please try again later.",
      retryAfter: context.after,
    }),
  });

  await fastify.register(require("@fastify/cookie"), {
    secret: process.env.COOKIE_SECRET,
    parseOptions: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
    },
  });

  await fastify.register(require("@fastify/formbody"));

  await fastify.register(require("@fastify/static"), {
    root: path.join(__dirname, "../public"),
    prefix: "/public/",
    cache: isProduction ? { maxAge: 86400000 } : false,
  });

  await fastify.register(require("@fastify/view"), {
    engine: { ejs: require("ejs") },
    root: path.join(__dirname, "views"),
    layout: false,
    includeViewExtension: true,
    options: { cache: isProduction },
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

  fastify.get(
    "/",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      return reply.view("home.ejs", { user: req.user });
    },
  );

  fastify.get(
    "/explore",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => reply.view("explore.ejs", { user: req.user }),
  );

  const auth = { preHandler: [fastify.authenticate] };

  const sendError = (reply, statusCode, message) =>
    reply.status(statusCode).send({ success: false, message });

  const findUserByUsername = async (username, select = "") => {
    const user = await User.findOne({ username }).select(select);
    if (!user) {
      const error = new Error(USER_NOT_FOUND);
      error.statusCode = 404;
      throw error;
    }
    return user;
  };

  fastify.get("/@:username", auth, async (req, reply) => {
    try {
      const user = await findUserByUsername(req.params.username);
      const isBlocked = user.blockedUsers?.includes(req.user._id) || false;

      return reply.view("profile.ejs", {
        profileUser: user,
        currentUser: req.user,
        isBlocked,
      });
    } catch (error) {
      req.log.error(
        { err: error, username: req.params.username },
        "Profile view error",
      );
      return sendError(reply, error.statusCode || 500, error.message);
    }
  });
};

fastify.setErrorHandler((error, request, reply) => {
  request.log.error({
    err: error,
    url: request.url,
    method: request.method,
    ip: request.ip,
  });

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

  const statusMessages = {
    429: "Too many requests",
    401: "Unauthorized",
    404: "Not found",
  };

  const message = statusMessages[error.statusCode];
  if (message) {
    return reply.status(error.statusCode).send({
      success: false,
      message,
    });
  }

  return reply.status(error.statusCode || 500).send({
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
  return reply.view("404.ejs", { user: req.user || null });
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

const shutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down...`);

  const forceShutdownTimeout = setTimeout(() => {
    fastify.log.error("Forced shutdown after 10s timeout");
    process.exit(1);
  }, 10000);

  forceShutdownTimeout.unref();

  try {
    await Promise.allSettled([
      fastify.close(),
      mongoose.connection.close(),
      fastify.redis?.quit(),
    ]);

    fastify.log.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    fastify.log.error(`Shutdown error: ${error.message}`);

    try {
      fastify.redis?.disconnect();
    } catch (redisError) {
      fastify.log.error(`Redis disconnect error: ${redisError.message}`);
    }

    process.exit(1);
  } finally {
    clearTimeout(forceShutdownTimeout);
  }
};

const start = async () => {
  await connectDB();
  await registerPlugins();
  await fastify.listen({
    port: process.env.PORT || 3000,
    host: "0.0.0.0",
  });
};

const handleShutdownSignal = (signal) => {
  process.on(signal, () => shutdown(signal));
};

["SIGTERM", "SIGINT"].forEach(handleShutdownSignal);

process.on("unhandledRejection", (error) => {
  fastify.log.error({ err: error }, "Unhandled rejection");
  shutdown("UNHANDLED_REJECTION");
});

process.on("uncaughtException", (error) => {
  fastify.log.error({ err: error }, "Uncaught exception");
  shutdown("UNCAUGHT_EXCEPTION");
});

start().catch((error) => {
  fastify.log.error(error);
  process.exit(1);
});
