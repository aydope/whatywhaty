const Joi = require("joi");

const updateProfileSchema = Joi.object({
  username: Joi.string().alphanum().min(3).max(30).messages({
    "string.alphanum": "نام کاربری فقط می‌تواند شامل حروف و اعداد باشد",
    "string.min": "نام کاربری باید حداقل {#limit} کاراکتر باشد",
    "string.max": "نام کاربری نمی‌تواند بیشتر از {#limit} کاراکتر باشد",
  }),

  email: Joi.string().email({ minDomainSegments: 2 }).messages({
    "string.email": "لطفاً یک آدرس ایمیل معتبر وارد کنید",
    "string.empty": "ایمیل نمی‌تواند خالی باشد",
  }),
})
  .min(1)
  .messages({
    "object.min": "حداقل یکی از فیلدها باید برای بروزرسانی ارسال شود",
  });

const userIdSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "فرمت شناسه کاربر معتبر نیست",
      "any.required": "شناسه کاربر الزامی است",
      "string.empty": "شناسه کاربر نمی‌تواند خالی باشد",
    }),
});

module.exports = {
  updateProfileSchema,
  userIdSchema,
};
