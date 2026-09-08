const Joi = require("joi");

const createPostSchema = Joi.object({
  content: Joi.string().min(1).max(280).required().trim().messages({
    "string.min": "متن پست نمی‌تواند خالی باشد",
    "string.max": "متن پست نمی‌تواند بیشتر از {#limit} کاراکتر باشد",
    "any.required": "وارد کردن متن پست الزامی است",
    "string.empty": "متن پست نمی‌تواند خالی باشد",
    "string.trim": "متن پست نمی‌تواند فقط شامل فاصله باشد",
  }),
});

const updatePostSchema = Joi.object({
  content: Joi.string().min(1).max(280).required().trim().messages({
    "string.min": "متن پست نمی‌تواند خالی باشد",
    "string.max": "متن پست نمی‌تواند بیشتر از {#limit} کاراکتر باشد",
    "string.empty": "متن پست نمی‌تواند خالی باشد",
    "string.trim": "متن پست نمی‌تواند فقط شامل فاصله باشد",
  }),
});

module.exports = {
  createPostSchema,
  updatePostSchema,
};
