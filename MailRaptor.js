#!/usr/bin/env node
process.stdout.write('\x1Bc');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const pLimit = require('p-limit').default;
const { parse } = require('csv-parse/sync');
const chalk = require('chalk').default;
const inquirer = require('inquirer').default;
const banner = `
                                                             
                                                             
██▄  ▄██  ▄▄▄  ▄▄ ▄▄    █████▄   ▄▄▄  ▄▄▄▄ ▄▄▄▄▄▄ ▄▄▄  ▄▄▄▄  
██ ▀▀ ██ ██▀██ ██ ██    ██▄▄██▄ ██▀██ ██▄█▀  ██  ██▀██ ██▄█▄ 
██    ██ ██▀██ ██ ██▄▄▄ ██   ██ ██▀██ ██     ██  ▀███▀ ██ ██ 
                                                             
                   --- Dev : Frenzyy ---
`;
console.log(chalk.cyan(banner));

function readLines(file) {
    return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
}

function parseSmtpLine(line) {
    const parts = line.split(':');
    if (parts.length < 5) throw new Error('Invalid SMTP line: ' + line);
    const [host, port, secure, user, pass] = parts;
    return { host, port: Number(port), secure: secure === 'true' || secure === '1', auth: { user, pass } };
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

function spintax(text) {
    return text.replace(/\{([^{}]+)\}/g, (_, group) => {
        const opts = group.split('|');
        return opts[Math.floor(Math.random() * opts.length)];
    });
}

function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function appendLog(file, row) {
    fs.appendFileSync(file, row.join(',') + '\n');
}

function ensureLogHeader(file) {
    if (!fs.existsSync(file)) {
        appendLog(file, ['timestamp', 'smtp_host', 'smtp_user', 'to', 'subject', 'status', 'error']);
    }
}

function loadRecipients(file) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (/,/.test(raw) && /email/i.test(raw.split(/\r?\n/)[0])) {
        const rows = parse(raw, { columns: true, skip_empty_lines: true });
        return rows.map(r => r.email).filter(Boolean);
    }
    return readLines(file).filter(line => /@/.test(line));
}

async function sendBatchWithSmtp(smtpConfig, recipients, content, subject, from, optsGlobal) {
    const transporter = nodemailer.createTransport(smtpConfig);
    try { await transporter.verify(); } catch (e) {
        console.error(chalk.redBright(`[SMTP VERIFY FAILED] ${smtpConfig.host} ${smtpConfig.auth.user} -> ${e.message}`));
        return;
    }

    const senderName = from.includes('<') ? from.split('<')[0].trim() : 'Frenzyyy';
    const fromEmail = smtpConfig.auth.user;
    const finalFrom = `"${senderName}" <${fromEmail}>`;

    for (const to of recipients) {
        const personalized = spintax(content);
        const mail = { from: finalFrom, to, subject: spintax(subject), html: personalized };
        let attempt = 0, success = false;

        while (attempt <= optsGlobal.retries && !success) {
            try {
                attempt++;
                await transporter.sendMail(mail);
                success = true;
                appendLog(optsGlobal.log, [new Date().toISOString(), smtpConfig.host, smtpConfig.auth.user, to, mail.subject, 'OK', '']);
                process.stdout.write(chalk.greenBright(` + [OK] ${to} via ${smtpConfig.auth.user}\n`));
            } catch (err) {
                appendLog(optsGlobal.log, [new Date().toISOString(), smtpConfig.host, smtpConfig.auth.user, to, mail.subject, 'FAIL', JSON.stringify(String(err.message || err))]);
                process.stdout.write(chalk.redBright(` - [FAIL] ${to} (attempt ${attempt}) via ${smtpConfig.auth.user} -> ${String(err.message).slice(0, 80)}\n`));
                if (attempt <= optsGlobal.retries) await sleep(500 * attempt);
            }
        }
        await sleep(randomDelay(optsGlobal.delayMin, optsGlobal.delayMax));
    }
}

async function main() {
    const logsFolder = path.join(__dirname, 'Logs');
    if (!fs.existsSync(logsFolder)) fs.mkdirSync(logsFolder, { recursive: true });

    const answers = await inquirer.prompt([
        { type: 'input', name: 'smtps', message: 'Enter SMTP file path:', default: path.join('Credentials','smtps.txt') },
        { type: 'input', name: 'recipients', message: 'Enter recipients file path:', default: path.join('Credentials','recipients.txt') },
        { type: 'input', name: 'template', message: 'Enter HTML template file path:', default: path.join('Credentials','template.html') },
        { type: 'input', name: 'from', message: 'Sender name/email (display name only used):', default:'Frenzyyy Test <no-reply@Frenzyyy.com>' },
        { type: 'input', name: 'subject', message: 'Email subject:', default:'FrenzyMailer Test!' },
        { type: 'number', name: 'batchSize', message: 'Batch size (emails per SMTP):', default:100 },
        { type: 'number', name: 'concurrency', message: 'Concurrency (parallel SMTPs):', default:5 },
        { type: 'number', name: 'retries', message: 'Retries per email on fail:', default:2 },
        { type: 'number', name: 'delayMin', message: 'Min delay between emails (ms):', default:300 },
        { type: 'number', name: 'delayMax', message: 'Max delay between emails (ms):', default:900 },
        { type: 'input', name: 'log', message: 'Log CSV file path:', default: path.join('Logs','send-log.csv') }
    ]);

    try {
        const smtpLines = readLines(answers.smtps);
        if (smtpLines.length === 0) throw new Error('No SMTPs provided');
        const smtps = smtpLines.map(parseSmtpLine);

        const recipients = loadRecipients(answers.recipients);
        if (recipients.length === 0) throw new Error('No recipients found');

        const template = fs.readFileSync(answers.template,'utf8');
        ensureLogHeader(answers.log);

        shuffle(recipients);

        const batchSize = answers.batchSize;
        const recipientBatches = [];
        for (let i = 0; i < recipients.length; i += batchSize) recipientBatches.push(recipients.slice(i, i + batchSize));

        console.log(chalk.greenBright(`Loaded ${smtps.length} SMTP(s), ${recipients.length} recipients -> ${recipientBatches.length} batches (batchSize=${batchSize})`));

        const limit = pLimit(answers.concurrency);
        let smtpIndex = 0;

        const tasks = recipientBatches.map((batch, i) => limit(async () => {
            const smtp = smtps[smtpIndex % smtps.length];
            smtpIndex++;
            console.log(chalk.blueBright(`-> Sending batch ${i + 1}/${recipientBatches.length} (${batch.length} emails) using ${smtp.auth.user}@${smtp.host}`));
            await sendBatchWithSmtp(smtp, batch, template, answers.subject, answers.from, answers);
        }));

        await Promise.all(tasks);
        console.log(chalk.greenBright('\nAll batches processed. Check the log file for details.'));
    } catch (err) {
        console.error(chalk.redBright('Fatal error:'), err);
        process.exit(1);
    }
}

main();
