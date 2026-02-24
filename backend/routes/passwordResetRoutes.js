import express from "express";
import bcrypt from "bcryptjs";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import pool from "../db.js";
import { authenticateToken, requireAdmin } from "../middleware/authMiddleware.js";
import { sendMail } from "../utils/mailer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

function escapeHtml(s) {
  if (s == null) return "";
  const str = String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getLogoAttachment() {
  const baseDirs = [
    path.join(__dirname, "..", "..", "frontend", "images"),
    path.join(process.cwd(), "frontend", "images"),
  ];
  const names = ["DM-logo.jpg", "dm-logo.jpg", "DM-logo.JPG", "DM-logo.jpeg", "DM-logo.png"];
  for (const dir of baseDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of names) {
        const logoPath = path.join(dir, name);
        if (fs.existsSync(logoPath)) {
          const buffer = fs.readFileSync(logoPath);
          return { buffer, filename: name };
        }
      }
      const files = fs.readdirSync(dir);
      const img = files.find((f) => /\.(jpe?g|png)$/i.test(f));
      if (img) {
        const logoPath = path.join(dir, img);
        const buffer = fs.readFileSync(logoPath);
        return { buffer, filename: img };
      }
    } catch {
      
    }
  }
  return null;
}

function randomTempPassword() {
  
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}


router.use(authenticateToken, requireAdmin);


router.get("/pending-count", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM password_reset_requests WHERE status = 'pending'",
    );
    return res.json({ pending: Number(rows?.[0]?.cnt || 0) });
  } catch (err) {
    console.error("GET /api/password-resets/pending-count:", err);
    return res.status(500).json({ message: "Failed to load pending count." });
  }
});


router.get("/requests", async (req, res) => {
  try {
    const status = (req.query.status || "pending").toString();
    const allowed = new Set(["pending", "resolved", "rejected"]);
    const st = allowed.has(status) ? status : "pending";

    let sql;
    const params = [];
    if (st === "pending") {
      
      sql = `SELECT pr.request_id AS id,
                    pr.user_id,
                    pr.username,
                    pr.requested_at,
                    pr.status,
                    pr.resolved_at,
                    pr.resolved_by,
                    pr.resolution_note,
                    u.email,
                    u.name AS user_name
             FROM password_reset_requests pr
             INNER JOIN (
               SELECT username, MAX(request_id) AS latest_id
               FROM password_reset_requests
               WHERE status = 'pending'
               GROUP BY username
             ) latest ON latest.username = pr.username AND latest.latest_id = pr.request_id
             LEFT JOIN users u ON u.user_id = pr.user_id
             WHERE pr.status = 'pending'
             ORDER BY pr.requested_at DESC
             LIMIT 100`;
    } else {
      sql = `SELECT pr.request_id AS id,
                    pr.user_id,
                    pr.username,
                    pr.requested_at,
                    pr.status,
                    pr.resolved_at,
                    pr.resolved_by,
                    pr.resolution_note,
                    u.email,
                    u.name AS user_name
             FROM password_reset_requests pr
             LEFT JOIN users u ON u.user_id = pr.user_id
             WHERE pr.status = ?
             ORDER BY pr.requested_at DESC
             LIMIT 100`;
      params.push(st);
    }

    const [rows] = await pool.query(sql, params);
    return res.json({ requests: rows });
  } catch (err) {
    console.error("GET /api/password-resets/requests:", err);
    return res.status(500).json({ message: "Failed to load requests." });
  }
});


router.put("/requests/:id/resolve", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const requestId = Number(req.params.id);
    if (!requestId) return res.status(400).json({ message: "Invalid request id." });

    const note = (req.body?.note || "").toString().slice(0, 255) || null;
    const newPasswordRaw = typeof req.body?.new_password === "string" ? req.body.new_password.trim() : "";
    const generate = req.body?.generate === true;

    let newPassword;
    if (generate) {
      newPassword = randomTempPassword();
    } else if (newPasswordRaw) {
      newPassword = newPasswordRaw;
    } else {
      return res.status(400).json({
        message: "Provide new_password (the password you set) or set generate to true to auto-generate.",
      });
    }

    await conn.beginTransaction();

    const [reqRows] = await conn.query(
      `SELECT pr.request_id, pr.user_id, pr.username, pr.status, u.email, u.name
       FROM password_reset_requests pr
       LEFT JOIN users u ON u.user_id = pr.user_id
       WHERE pr.request_id = ?`,
      [requestId],
    );
    if (reqRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Request not found." });
    }
    const pr = reqRows[0];
    if (pr.status !== "pending") {
      await conn.rollback();
      return res.status(409).json({ message: "Request is not pending." });
    }
    if (!pr.user_id) {
      await conn.rollback();
      return res.status(400).json({ message: "No user is linked to this request." });
    }
    if (!pr.email) {
      await conn.rollback();
      return res.status(400).json({ message: "User has no email set." });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await conn.query(
      "UPDATE users SET password_hash = ? WHERE user_id = ?",
      [passwordHash, pr.user_id],
    );

    await conn.query(
      `UPDATE password_reset_requests
       SET status = 'resolved',
           resolved_at = datetime('now','localtime'),
           resolved_by = ?,
           resolution_note = ?
       WHERE request_id = ?`,
      [req.user.userId, note, requestId],
    );

    await conn.query(
      `UPDATE password_reset_requests
       SET status = 'resolved',
           resolved_at = datetime('now','localtime'),
           resolved_by = ?,
           resolution_note = 'Superseded.'
       WHERE user_id = ? AND status = 'pending' AND request_id != ?`,
      [req.user.userId, pr.user_id, requestId],
    );

    await conn.commit();

    const userName = pr.name || pr.username;
    const logoAttach = getLogoAttachment();
    const text =
      `Hi ${userName},\n\n` +
      `Your password reset request has been resolved.\n\n` +
      `New password: ${newPassword}\n\n` +
      "- D&M Sales Admin";

    const logoImgTag = logoAttach
      ? "<img src=\"cid:dmLogo\" alt=\"D&M Construction Supply\" class=\"logo-img\" style=\"display: block; width: 200%; min-width: 100%; max-height: 72px; height: auto; vertical-align: top;\" />"
      : "<span style='color:#fff;font-weight:bold;font-size:18px'>D&M Construction Supply</span>";

    const html = [
      "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>",
      "<style>",
      "body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 24px; background: #f5f5f5; }",
      ".email-wrap { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }",
      ".email-header { background: #2c3e50; padding: 0; line-height: 0; width: 100%; display: block; box-sizing: border-box; }",
      ".email-header .logo-img { display: block; width: 100%; min-width: 100%; max-width: 100%; height: auto; max-height: 72px; object-fit: contain; }",
      ".email-body { padding: 24px; color: #333; line-height: 1.6; font-size: 15px; }",
      ".email-body p { margin: 0 0 12px; }",
      ".email-body .greeting { font-size: 16px; }",
      ".password-box { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 12px 16px; margin: 16px 0; font-family: monospace; font-size: 14px; word-break: break-all; }",
      ".email-footer { padding: 16px 24px; background: #f8f9fa; font-size: 12px; color: #6c757d; }",
      "</style></head><body>",
      "<div class='email-wrap'>",
      "<div class='email-header'>",
      logoImgTag,
      "</div>",
      "<div class='email-body'>",
      `<p class='greeting'>Hi ${escapeHtml(userName)},</p>`,
      "<p>Your password reset request has been resolved.</p>",
      "<p><strong>New password:</strong></p>",
      `<div class='password-box'>${escapeHtml(newPassword)}</div>`,
      "</div>",
      "<div class='email-footer'>— D&M Sales Admin</div>",
      "</div></body></html>",
    ].join("");

    const attachments = logoAttach
      ? [
          {
            filename: logoAttach.filename,
            content: logoAttach.buffer,
            cid: "dmLogo",
          },
        ]
      : undefined;

    await sendMail({
      to: pr.email,
      subject: "Password Reset - D&M Sales",
      text,
      html,
      attachments,
    });

    return res.json({ message: "Request resolved and emailed." });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error("PUT /api/password-resets/requests/:id/resolve:", err);
    return res.status(500).json({ message: err.message || "Failed to resolve request." });
  } finally {
    conn.release();
  }
});

export default router;

