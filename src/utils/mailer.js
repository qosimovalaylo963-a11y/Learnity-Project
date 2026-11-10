/**
 * Configurable SMTP & Transactional Email Client for Learnity
 *
 * - Reads `OWNER_EMAIL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
 *   `SMTP_FROM`, or `RESEND_API_KEY` from environment variables.
 * - Never fabricates email delivery: only returns `sent: true` when the configured SMTP
 *   server or transactional HTTP provider confirms receipt with a 2xx response.
 * - Records every delivery attempt and configurable notification template in the
 *   `notifications` table.
 */
const net = require('net');
const tls = require('tls');
const https = require('https');

const DEFAULT_TEMPLATES = {
    application_received_owner: {
        subject: '[Learnity] New {{requested_role}} Application — {{full_name}} ({{application_uid}})',
        body: `Hello Learnity Owner,\n\nA new {{requested_role}} application has been submitted on Learnity.\n\nApplication ID: {{application_uid}}\nApplicant: {{full_name}}\nEmail: {{email}}\nPhone / Telegram: {{phone_or_telegram}}\nInterested Subjects: {{interested_subjects}}\nTrack / Schedule: {{track}} ({{schedule_preference}})\nEducational Background:\n{{educational_background}}\n\nMotivation Statement:\n{{motivation_statement}}\n\nReview this application in your Owner Dashboard.`
    },
    application_status_applicant: {
        subject: 'Update on Your Learnity Application ({{application_uid}}) — {{status}}',
        body: `Hello {{full_name}},\n\nYour application ({{application_uid}}) for the {{requested_role}} role at Learnity has been updated to: {{status}}.\n\nCoordinator Notes:\n{{review_notes}}\n\n{{invitation_section}}\nWarm regards,\nLearnity — The Lively Teaching Project`
    }
};

function renderTemplate(templateStr, variables = {}) {
    return String(templateStr || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
        return variables[key] !== undefined && variables[key] !== null ? String(variables[key]) : '';
    });
}

function sendViaSmtpSocket({ host, port, secure, user, pass, from, to, subject, text }) {
    return new Promise((resolve) => {
        const timeoutMs = 8000;
        let socket;
        let buffer = '';
        let step = 0;
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            try { socket && socket.destroy(); } catch (_) {}
            resolve(result);
        };

        const sendLine = (cmd) => {
            socket.write(cmd + '\r\n');
        };

        const onData = (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\r\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (line.length >= 4 && line[3] === '-') continue; // Multi-line SMTP continuation
                const code = parseInt(line.slice(0, 3), 10);
                if (code >= 400) {
                    return finish({ sent: false, detail: `SMTP error (${code}): ${line}` });
                }
                if (step === 0 && code === 220) {
                    step = 1;
                    sendLine(`EHLO learnity.local`);
                } else if (step === 1 && code === 250) {
                    if (user && pass) {
                        step = 2;
                        sendLine('AUTH LOGIN');
                    } else {
                        step = 4;
                        sendLine(`MAIL FROM:<${from}>`);
                    }
                } else if (step === 2 && code === 334) {
                    step = 3;
                    sendLine(Buffer.from(String(user)).toString('base64'));
                } else if (step === 3 && code === 334) {
                    step = 35;
                    sendLine(Buffer.from(String(pass)).toString('base64'));
                } else if (step === 35 && code === 235) {
                    step = 4;
                    sendLine(`MAIL FROM:<${from}>`);
                } else if (step === 4 && code === 250) {
                    step = 5;
                    sendLine(`RCPT TO:<${to}>`);
                } else if (step === 5 && (code === 250 || code === 251)) {
                    step = 6;
                    sendLine('DATA');
                } else if (step === 6 && code === 354) {
                    step = 7;
                    const msg = [
                        `From: ${from}`,
                        `To: ${to}`,
                        `Subject: ${subject.replace(/[\r\n]/g, ' ')}`,
                        `Date: ${new Date().toUTCString()}`,
                        `MIME-Version: 1.0`,
                        `Content-Type: text/plain; charset=utf-8`,
                        '',
                        text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
                        '.'
                    ].join('\r\n');
                    sendLine(msg);
                } else if (step === 7 && code === 250) {
                    step = 8;
                    sendLine('QUIT');
                    return finish({ sent: true, detail: `SMTP 250 OK (${host}:${port})` });
                }
            }
        };

        try {
            const opts = { host, port: Number(port) || 587, rejectUnauthorized: false };
            socket = secure ? tls.connect(opts) : net.createConnection(opts);
            socket.setTimeout(timeoutMs, () => finish({ sent: false, detail: 'SMTP connection timed out' }));
            socket.on('data', onData);
            socket.on('error', (err) => finish({ sent: false, detail: `SMTP socket error: ${err.message}` }));
        } catch (err) {
            finish({ sent: false, detail: `SMTP initialization failed: ${err.message}` });
        }
    });
}

function sendViaResendApi({ apiKey, from, to, subject, text }) {
    return new Promise((resolve) => {
        const body = JSON.stringify({ from, to: [to], subject, text });
        const req = https.request(
            {
                hostname: 'api.resend.com',
                path: '/emails',
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout: 8000
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ sent: true, detail: `Resend API ${res.statusCode}: ${data}` });
                    } else {
                        resolve({ sent: false, detail: `Resend API error ${res.statusCode}: ${data}` });
                    }
                });
            }
        );
        req.on('error', (err) => resolve({ sent: false, detail: `Resend request failed: ${err.message}` }));
        req.write(body);
        req.end();
    });
}

async function getNotificationTemplate(db, templateKey) {
    const row = await db.get(
        "SELECT subject, body FROM notifications WHERE channel = 'template' AND template_key = ? ORDER BY id DESC LIMIT 1",
        [templateKey]
    );
    if (row) return row;
    return DEFAULT_TEMPLATES[templateKey] || { subject: 'Learnity Notification', body: '{{message}}' };
}

async function sendEmailNotification(db, { to, templateKey, variables = {}, customSubject, customBody }) {
    const ownerEmail = (process.env.OWNER_EMAIL || '').trim();
    const recipient = (to || ownerEmail).trim();
    const tpl = await getNotificationTemplate(db, templateKey);
    const subject = customSubject || renderTemplate(tpl.subject, variables);
    const body = customBody || renderTemplate(tpl.body, variables);

    const smtpHost = (process.env.SMTP_HOST || '').trim();
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
    const smtpSecure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || smtpPort === 465;
    const smtpUser = (process.env.SMTP_USER || '').trim();
    const smtpPass = (process.env.SMTP_PASS || '').trim();
    const smtpFrom = (process.env.SMTP_FROM || smtpUser || 'no-reply@learnity.org').trim();
    const resendApiKey = (process.env.RESEND_API_KEY || '').trim();

    let result = {
        sent: false,
        detail: 'Email provider not configured (set OWNER_EMAIL and SMTP_HOST/SMTP_USER/SMTP_PASS or RESEND_API_KEY in .env). Notification recorded in Owner Dashboard.'
    };

    if (!recipient) {
        result = {
            sent: false,
            detail: 'OWNER_EMAIL is not configured in environment variables. Application saved to database and Owner Dashboard.'
        };
    } else if (smtpHost) {
        result = await sendViaSmtpSocket({
            host: smtpHost,
            port: smtpPort,
            secure: smtpSecure,
            user: smtpUser,
            pass: smtpPass,
            from: smtpFrom,
            to: recipient,
            subject,
            text: body
        });
    } else if (resendApiKey) {
        result = await sendViaResendApi({
            apiKey: resendApiKey,
            from: smtpFrom,
            to: recipient,
            subject,
            text: body
        });
    }

    await db.run(
        `INSERT INTO notifications (recipient_email, channel, template_key, subject, body, delivery_status, provider_response)
         VALUES (?, 'email', ?, ?, ?, ?, ?)`,
        [recipient || 'unconfigured', templateKey || 'custom', subject, body, result.sent ? 'delivered' : 'pending', result.detail]
    );

    return {
        sent: result.sent,
        recipient: recipient || null,
        subject,
        detail: result.detail
    };
}

module.exports = {
    DEFAULT_TEMPLATES,
    renderTemplate,
    getNotificationTemplate,
    sendEmailNotification
};
