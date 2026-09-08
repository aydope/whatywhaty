const Joi = require("joi");

const passwordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*])/;

const registerSchema = Joi.object({
  username: Joi.string().alphanum().min(3).max(30).required().messages({
    "string.alphanum": "نام کاربری فقط می‌تواند شامل حروف و اعداد باشد",
    "string.min": "نام کاربری باید حداقل ۳ کاراکتر باشد",
    "string.max": "نام کاربری نمی‌تواند بیشتر از ۳۰ کاراکتر باشد",
    "any.required": "وارد کردن نام کاربری الزامی است",
    "string.empty": "نام کاربری نمی‌تواند خالی باشد",
  }),

  email: Joi.string().email({ minDomainSegments: 2 }).required().messages({
    "string.email": "لطفاً یک آدرس ایمیل معتبر وارد کنید",
    "any.required": "وارد کردن ایمیل الزامی است",
    "string.empty": "ایمیل نمی‌تواند خالی باشد",
  }),

  password: Joi.string()
    .min(8)
    .max(128)
    .pattern(passwordPattern)
    .required()
    .messages({
      "string.min": "رمز عبور باید حداقل ۸ کاراکتر باشد",
      "string.max": "رمز عبور نمی‌تواند بیشتر از ۱۲۸ کاراکتر باشد",
      "string.pattern.base":
        "رمز عبور باید شامل حداقل یک حرف بزرگ، یک حرف کوچک، یک عدد و یک کاراکتر خاص باشد",
      "any.required": "وارد کردن رمز عبور الزامی است",
      "string.empty": "رمز عبور نمی‌تواند خالی باشد",
    }),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required().messages({
    "string.email": "لطفاً یک آدرس ایمیل معتبر وارد کنید",
    "any.required": "وارد کردن ایمیل الزامی است",
    "string.empty": "ایمیل نمی‌تواند خالی باشد",
  }),

  password: Joi.string().required().messages({
    "any.required": "وارد کردن رمز عبور الزامی است",
    "string.empty": "رمز عبور نمی‌تواند خالی باشد",
  }),
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required().messages({
    "any.required": "وارد کردن رمز عبور فعلی الزامی است",
    "string.empty": "رمز عبور فعلی نمی‌تواند خالی باشد",
  }),

  newPassword: Joi.string()
    .min(8)
    .max(128)
    .pattern(passwordPattern)
    .required()
    .messages({
      "string.min": "رمز عبور جدید باید حداقل ۸ کاراکتر باشد",
      "string.max": "رمز عبور جدید نمی‌تواند بیشتر از ۱۲۸ کاراکتر باشد",
      "string.pattern.base":
        "رمز عبور جدید باید شامل حداقل یک حرف بزرگ، یک حرف کوچک، یک عدد و یک کاراکتر خاص باشد",
      "any.required": "وارد کردن رمز عبور جدید الزامی است",
      "string.empty": "رمز عبور جدید نمی‌تواند خالی باشد",
    }),
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required().messages({
    "string.email": "لطفاً یک آدرس ایمیل معتبر وارد کنید",
    "any.required": "وارد کردن ایمیل الزامی است",
    "string.empty": "ایمیل نمی‌تواند خالی باشد",
  }),
});

const resetPasswordSchema = Joi.object({
  token: Joi.string().required().messages({
    "any.required": "توکن بازنشانی الزامی است",
    "string.empty": "توکن بازنشانی نمی‌تواند خالی باشد",
  }),

  password: Joi.string()
    .min(8)
    .max(128)
    .pattern(passwordPattern)
    .required()
    .messages({
      "string.min": "رمز عبور باید حداقل ۸ کاراکتر باشد",
      "string.max": "رمز عبور نمی‌تواند بیشتر از ۱۲۸ کاراکتر باشد",
      "string.pattern.base":
        "رمز عبور باید شامل حداقل یک حرف بزرگ، یک حرف کوچک، یک عدد و یک کاراکتر خاص باشد",
      "any.required": "وارد کردن رمز عبور الزامی است",
      "string.empty": "رمز عبور نمی‌تواند خالی باشد",
    }),
});

module.exports = {
  registerSchema,
  loginSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
};
