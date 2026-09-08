const fp = require("fastify-plugin");

const UNAUTHORIZED = {
  success: false,
  message: "احراز هویت لازم است",
  code: "UNAUTHORIZED",
};
const SERVER_ERROR = {
  success: false,
  message: "خطا در بررسی دسترسی",
  code: "SERVER_ERROR",
};
const ROLE_LEVELS = { user: 1, admin: 2 };

const ensureAuth = (req, reply) => {
  if (!req.user) return reply.status(401).send(UNAUTHORIZED);
  return null;
};

const createRoleGuard = (validator) => {
  return async (req, reply) => {
    const authError = ensureAuth(req, reply);
    if (authError) return;

    try {
      const error = validator(req);
      if (error) return reply.status(403).send(error);
    } catch (err) {
      req.log.error(err);
      return reply.status(500).send(SERVER_ERROR);
    }
  };
};

module.exports = fp(async (fastify) => {
  fastify.decorate("checkRole", (roles) => {
    const rolesArray = Array.isArray(roles) ? roles : [roles];
    return createRoleGuard((req) => {
      if (!rolesArray.includes(req.user.role)) {
        return {
          success: false,
          message: `دسترسی محدود. نیاز به نقش: ${rolesArray.join(" یا ")}`,
          code: "FORBIDDEN",
          requiredRoles: rolesArray,
          userRole: req.user.role,
        };
      }
      return null;
    });
  });

  fastify.decorate(
    "isAdmin",
    createRoleGuard((req) => {
      if (req.user.role !== "admin") {
        return {
          success: false,
          message: "دسترسی فقط برای مدیران",
          code: "FORBIDDEN",
        };
      }
      return null;
    }),
  );

  fastify.decorate("hasAnyRole", (roles) => {
    const rolesArray = Array.isArray(roles) ? roles : [roles];
    return createRoleGuard((req) => {
      if (!rolesArray.includes(req.user.role)) {
        return {
          success: false,
          message: `دسترسی محدود. نیاز به یکی از نقش‌های: ${rolesArray.join("، ")}`,
          code: "FORBIDDEN",
        };
      }
      return null;
    });
  });

  fastify.decorate("checkRoleLevel", (minLevel) => {
    const requiredLevel = ROLE_LEVELS[minLevel] || 0;
    return createRoleGuard((req) => {
      const userLevel = ROLE_LEVELS[req.user.role] || 0;
      if (userLevel < requiredLevel) {
        return {
          success: false,
          message: `دسترسی محدود. نیاز به سطح دسترسی حداقل ${minLevel}`,
          code: "FORBIDDEN",
          requiredLevel: minLevel,
          userLevel: req.user.role,
        };
      }
      return null;
    });
  });
});
