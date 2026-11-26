const nodemailer = require("nodemailer");

let transport = null;

const getTransport = () => {
  if (!process.env.SMTP_URL) return null;
  if (!transport) transport = nodemailer.createTransport(process.env.SMTP_URL);
  return transport;
};

const sendPasswordResetEmail = async (fastify, { to, username, link }) => {
  const mailer = getTransport();

  if (!mailer) {
    if (process.env.NODE_ENV === "production") {
      fastify.log.error(
        "SMTP_URL is not configured, password reset email was not sent",
      );
    } else {
      fastify.log.info({ link }, "Password reset link (SMTP not configured)");
    }
    return false;
  }

  await mailer.sendMail({
    from: process.env.MAIL_FROM || "واتی‌واتی <no-reply@localhost>",
    to,
    subject: "بازنشانی رمز عبور واتی‌واتی",
    text: `سلام ${username}\n\nبرای انتخاب رمز عبور جدید این لینک را باز کنید (تا ۳۰ دقیقه معتبر است):\n${link}\n\nاگر شما این درخواست را نداده‌اید، این ایمیل را نادیده بگیرید.`,
  });
  return true;
};

module.exports = { sendPasswordResetEmail };
