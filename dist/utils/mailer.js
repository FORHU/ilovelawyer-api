"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = void 0;
const nodemailer_1 = require("nodemailer");
const config_1 = require("../config");
async function sendEmail({ to, subject, text, html }) {
    const transporter = (0, nodemailer_1.createTransport)({
        host: config_1.MAILER_TRANSPORT_HOST,
        port: config_1.MAILER_TRANSPORT_PORT,
        secure: config_1.MAILER_TRANSPORT_SECURE,
        auth: {
            user: config_1.MAILER_EMAIL,
            pass: config_1.MAILER_PASSWORD,
        },
    });
    console.log(config_1.MAILER_EMAIL, config_1.MAILER_PASSWORD, config_1.MAILER_TRANSPORT_HOST, config_1.MAILER_TRANSPORT_PORT);
    const mailOptions = {
        from: `Seven 365 <${config_1.MAILER_EMAIL}>`,
        to,
        subject,
    };
    if (text) {
        mailOptions.text = text;
    }
    if (html) {
        mailOptions.html = html;
    }
    try {
        await transporter.sendMail(mailOptions);
        return Promise.resolve("Email sent successfully");
    }
    catch (error) {
        return Promise.reject(error);
    }
}
exports.sendEmail = sendEmail;
//# sourceMappingURL=mailer.js.map