import nodemailer from "nodemailer";

function isConfigured() {
  return (
    !!process.env.SMTP_HOST &&
    !!process.env.SMTP_PORT &&
    !!process.env.SMTP_USER &&
    !!process.env.SMTP_PASS &&
    !!process.env.MAIL_FROM
  );
}

export function mailerStatus() {
  return { configured: isConfigured() };
}

export async function sendMail({ to, subject, text, html, attachments }) {
  if (!isConfigured()) {
    const err = new Error(
      "Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.",
    );
    err.code = "MAIL_NOT_CONFIGURED";
    throw err;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const payload = {
    from: process.env.MAIL_FROM,
    to,
    subject,
    text: text ?? (html ? undefined : ""),
    html: html || undefined,
    attachments: attachments || undefined,
  };
  return transporter.sendMail(payload);
}

