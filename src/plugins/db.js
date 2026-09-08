const fp = require("fastify-plugin");
const mongoose = require("mongoose");

module.exports = fp(async (fastify) => {
  const MONGO_URI = process.env.MONGODB_URI;
  const isProduction = process.env.NODE_ENV === "production";

  if (!MONGO_URI) {
    fastify.log.error("MONGODB_URI is not defined in environment variables");
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      family: 4,
    });
    fastify.log.info("MongoDB connected");
  } catch (err) {
    fastify.log.error({ err }, "MongoDB connection failed");
    process.exit(1);
  }

  mongoose.connection.on("error", (err) => {
    fastify.log.error({ err }, "MongoDB error");
  });

  mongoose.connection.on("disconnected", () => {
    fastify.log.warn("MongoDB disconnected");
  });

  mongoose.connection.on("reconnected", () => {
    fastify.log.info("MongoDB reconnected");
  });

  fastify.decorate("mongoose", mongoose);

  fastify.addHook("onClose", async () => {
    try {
      await mongoose.connection.close();
      fastify.log.info("MongoDB connection closed");
    } catch (err) {
      fastify.log.error({ err }, "Error closing MongoDB");
    }
  });
});
