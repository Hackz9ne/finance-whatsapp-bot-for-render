const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const QRCode = require('qrcode');
const terminalQR = require('qrcode-terminal');
const pino = require('pino');

const BOT_NAME = 'Anubis';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_DATA_DIR = path.join(DATA_DIR, 'session_data');
const CHAT_LOG_DIR = path.join(DATA_DIR, 'chat_logs');
const CHAT_LOG_PATH = path.join(CHAT_LOG_DIR, 'messages.jsonl');
const QR_OUTPUT_DIR = path.join(DATA_DIR, 'artifacts');
const PRIMARY_KNOWLEDGE_PATH = process.env.KNOWLEDGE_FILE_PATH || '';
const LEGACY_KNOWLEDGE_PATH = 'D:\\finance app\\payment_gateway\\DOCS.txt';
const REPO_KNOWLEDGE_PATH = path.join(__dirname, 'knowledge', 'yourpay-docs.txt');
const FALLBACK_KNOWLEDGE_PATH = path.join(__dirname, 'knowledge', 'student-finance-wallet.txt');
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const QR_PNG_PATH = path.join(QR_OUTPUT_DIR, 'anubis-qr.png');
const QR_SVG_PATH = path.join(QR_OUTPUT_DIR, 'anubis-qr.svg');
const QR_TXT_PATH = path.join(QR_OUTPUT_DIR, 'anubis-qr.txt');
const KNOWLEDGE_URLS = [
    process.env.KNOWLEDGE_URL,
    'https://student-finance-wallet.42web.io',
    'http://student-finance-wallet.42web.io'
].filter(Boolean);
const KNOWLEDGE_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_REPLY_LENGTH = 900;
const startedUsers = new Set();
const conversationHistory = new Map();
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';

const STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from',
    'how', 'i', 'if', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or',
    'please', 'the', 'this', 'to', 'what', 'when', 'where', 'which', 'who', 'why',
    'with', 'you', 'your'
]);

let knowledgeCache = {
    loadedAt: 0,
    sourceLabel: 'local knowledge file',
    rawText: '',
    chunks: []
};

async function ensureDataDirectories() {
    await Promise.all([
        fs.mkdir(DATA_DIR, { recursive: true }),
        fs.mkdir(CHAT_LOG_DIR, { recursive: true }),
        fs.mkdir(QR_OUTPUT_DIR, { recursive: true })
    ]);
}

async function writeQrArtifacts(qrValue) {
    await ensureDataDirectories();

    await Promise.all([
        fs.writeFile(QR_TXT_PATH, qrValue, 'utf8'),
        QRCode.toFile(QR_PNG_PATH, qrValue, {
            type: 'png',
            errorCorrectionLevel: 'M',
            margin: 2,
            scale: 8
        }),
        QRCode.toFile(QR_SVG_PATH, qrValue, {
            type: 'svg',
            errorCorrectionLevel: 'M',
            margin: 2
        })
    ]);
}

async function appendChatLog(entry) {
    await ensureDataDirectories();
    await fs.appendFile(CHAT_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}

function normalizeWhitespace(value) {
    return value
        .replace(/\r/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function decodeHtmlEntities(value) {
    return value
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function stripHtml(html) {
    return normalizeWhitespace(
        decodeHtmlEntities(
            html
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|br)>/gi, '\n')
                .replace(/<[^>]+>/g, ' ')
        )
    );
}

function tokenize(text) {
    return normalizeWhitespace(text.toLowerCase())
        .replace(/[^a-z0-9./:_ -]+/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function truncateText(text, maxLength = MAX_REPLY_LENGTH) {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3).trim()}...`;
}

function createKnowledgeChunks(text) {
    return normalizeWhitespace(text)
        .split(/\n{2,}/)
        .map((chunk) => normalizeWhitespace(chunk))
        .filter((chunk) => chunk.length > 0)
        .map((chunk) => ({
            text: chunk,
            lowerText: chunk.toLowerCase(),
            tokens: tokenize(chunk)
        }));
}

function summarizeChunk(chunkText) {
    if (chunkText.length <= 320) {
        return chunkText;
    }

    const sentences = chunkText
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean);

    if (sentences.length === 0) {
        return truncateText(chunkText, 320);
    }

    let summary = '';
    for (const sentence of sentences) {
        const candidate = summary ? `${summary} ${sentence}` : sentence;
        if (candidate.length > 320) break;
        summary = candidate;
    }

    return summary || truncateText(chunkText, 320);
}

function scoreChunk(chunk, questionTokens, normalizedQuestion) {
    let score = 0;
    const chunkTokenCounts = new Map();

    for (const token of chunk.tokens) {
        chunkTokenCounts.set(token, (chunkTokenCounts.get(token) || 0) + 1);
    }

    for (const token of questionTokens) {
        if (chunkTokenCounts.has(token)) {
            score += 3 + Math.min(chunkTokenCounts.get(token), 2);
        }
    }

    if (normalizedQuestion.length > 12 && chunk.lowerText.includes(normalizedQuestion)) {
        score += 8;
    }

    return score;
}

function findRelevantChunks(question, knowledge, limit = 3) {
    const normalizedQuestion = normalizeWhitespace(question.toLowerCase());
    const questionTokens = tokenize(question);

    if (questionTokens.length === 0) {
        return [];
    }

    return knowledge.chunks
        .map((chunk) => ({
            chunk,
            score: scoreChunk(chunk, questionTokens, normalizedQuestion)
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
}

function buildAnswer(question, knowledge) {
    const rankedChunks = findRelevantChunks(question, knowledge, 4);

    if (tokenize(question).length === 0) {
        return 'Ask a specific question about Student Finance Wallet, payments, checkout, API keys, sessions, or status checks.';
    }

    if (rankedChunks.length === 0) {
        return `I could not find a solid answer in the Student Finance Wallet material. Try asking about payment sessions, QR checkout, API keys, status polling, Flutter, or the JavaScript checkout flow.\n\nSource: ${knowledge.sourceLabel}`;
    }

    const selectedChunks = [];
    const seenTexts = new Set();

    for (const entry of rankedChunks) {
        const summary = summarizeChunk(entry.chunk.text);
        if (seenTexts.has(summary)) continue;
        selectedChunks.push(summary);
        seenTexts.add(summary);

        if (selectedChunks.length === 2) break;
    }

    return truncateText(
        `${selectedChunks.join('\n\n')}\n\nSource: ${knowledge.sourceLabel}`,
        MAX_REPLY_LENGTH
    );
}

function decryptChallengeCookie(keyHex, ivHex, cipherHex) {
    const decipher = crypto.createDecipheriv(
        'aes-128-cbc',
        Buffer.from(keyHex, 'hex'),
        Buffer.from(ivHex, 'hex')
    );

    decipher.setAutoPadding(false);

    return Buffer.concat([
        decipher.update(Buffer.from(cipherHex, 'hex')),
        decipher.final()
    ]).toString('hex');
}

function parseCookieChallenge(html, baseUrl) {
    const cryptoMatch = html.match(/var a=toNumbers\("([^"]+)"\),b=toNumbers\("([^"]+)"\),c=toNumbers\("([^"]+)"\)/);
    const redirectMatch = html.match(/location\.href="([^"]+)"/);

    if (!cryptoMatch || !redirectMatch) {
        return null;
    }

    const [, keyHex, ivHex, cipherHex] = cryptoMatch;
    const cookieValue = decryptChallengeCookie(keyHex, ivHex, cipherHex);

    return {
        cookie: `__test=${cookieValue}`,
        nextUrl: new URL(redirectMatch[1], baseUrl).toString()
    };
}

function buildRequestHeaders(cookie) {
    return {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        ...(cookie ? { Cookie: cookie } : {})
    };
}

async function fetchKnowledgeFromSite(initialUrl) {
    let currentUrl = initialUrl;
    let cookie = '';

    for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await fetch(currentUrl, {
            headers: buildRequestHeaders(cookie),
            redirect: 'manual'
        });

        if (response.status >= 300 && response.status < 400) {
            const redirectTarget = response.headers.get('location');
            if (!redirectTarget) {
                throw new Error(`Redirect from ${currentUrl} did not include a location header.`);
            }

            currentUrl = new URL(redirectTarget, currentUrl).toString();
            continue;
        }

        const html = await response.text();
        const challenge = parseCookieChallenge(html, currentUrl);

        if (challenge) {
            cookie = challenge.cookie;
            currentUrl = challenge.nextUrl;
            continue;
        }

        const text = stripHtml(html);
        if (!text || /cookies are not enabled/i.test(text)) {
            throw new Error(`The site at ${initialUrl} returned a cookie challenge instead of readable content.`);
        }

        return {
            sourceLabel: currentUrl,
            rawText: text
        };
    }

    throw new Error(`Unable to fetch readable site content from ${initialUrl}.`);
}

async function loadKnowledge(forceRefresh = false) {
    const cacheIsFresh =
        !forceRefresh &&
        knowledgeCache.chunks.length > 0 &&
        Date.now() - knowledgeCache.loadedAt < KNOWLEDGE_CACHE_TTL_MS;

    if (cacheIsFresh) {
        return knowledgeCache;
    }

    for (const url of KNOWLEDGE_URLS) {
        try {
            const siteKnowledge = await fetchKnowledgeFromSite(url);
            knowledgeCache = {
                loadedAt: Date.now(),
                sourceLabel: siteKnowledge.sourceLabel,
                rawText: siteKnowledge.rawText,
                chunks: createKnowledgeChunks(siteKnowledge.rawText)
            };

            if (knowledgeCache.chunks.length > 0) {
                return knowledgeCache;
            }
        } catch (error) {
            console.log(`Knowledge fetch failed for ${url}: ${error.message}`);
        }
    }

    const localKnowledgePaths = [
        PRIMARY_KNOWLEDGE_PATH,
        LEGACY_KNOWLEDGE_PATH,
        REPO_KNOWLEDGE_PATH,
        FALLBACK_KNOWLEDGE_PATH
    ].filter(Boolean);

    for (const knowledgePath of localKnowledgePaths) {
        try {
            const fileText = await fs.readFile(knowledgePath, 'utf8');
            knowledgeCache = {
                loadedAt: Date.now(),
                sourceLabel: knowledgePath,
                rawText: normalizeWhitespace(fileText),
                chunks: createKnowledgeChunks(fileText)
            };

            if (knowledgeCache.chunks.length > 0) {
                return knowledgeCache;
            }
        } catch (error) {
            console.log(`Knowledge file read failed for ${knowledgePath}: ${error.message}`);
        }
    }

    throw new Error('No readable knowledge source was available.');
}

async function generateAiAnswer(sender, question, knowledge) {
    if (!OPENROUTER_API_KEY) {
        return buildAnswer(question, knowledge);
    }

    const relevantChunks = findRelevantChunks(question, knowledge, 3);
    if (relevantChunks.length === 0) {
        return buildAnswer(question, knowledge);
    }

    const contextText = relevantChunks
        .map((entry, index) => `Context ${index + 1}:\n${entry.chunk.text}`)
        .join('\n\n');

    const messages = [
        {
            role: 'system',
            content: [
                'You are Anubis, a WhatsApp assistant for Student Finance Wallet and YourPay.',
                'Answer only from the provided context and conversation history.',
                'If the answer is not in the context, say that it is not available in the docs.',
                'Keep answers concise and practical.'
            ].join(' ')
        },
        ...getConversationHistory(sender).slice(-4),
        {
            role: 'user',
            content: `Context:\n${contextText}\n\nQuestion: ${question}`
        }
    ];

    const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://student-finance-wallet.42web.io',
            'X-OpenRouter-Title': BOT_NAME
        },
        body: JSON.stringify({
            model: OPENROUTER_MODEL,
            messages,
            temperature: 0.2,
            max_tokens: 350
        })
    });

    if (!response.ok) {
        throw new Error(`OpenRouter request failed with status ${response.status}`);
    }

    const data = await response.json();
    const aiText = data?.choices?.[0]?.message?.content?.trim();

    if (!aiText) {
        throw new Error('OpenRouter returned an empty response.');
    }

    return truncateText(`${aiText}\n\nSource: ${knowledge.sourceLabel}`, MAX_REPLY_LENGTH);
}

function getMessageText(message) {
    return (
        message?.conversation ||
        message?.extendedTextMessage?.text ||
        message?.imageMessage?.caption ||
        ''
    ).trim();
}

function isGreeting(text) {
    return ['hi', 'hello', 'hey'].some((word) => text === word || text.startsWith(`${word} `));
}

function getConversationHistory(sender) {
    return conversationHistory.get(sender) || [];
}

function addConversationMessage(sender, role, content) {
    const history = getConversationHistory(sender);
    history.push({ role, content: truncateText(content, 500) });
    conversationHistory.set(sender, history.slice(-6));
}

function buildWelcomeMessage(knowledge) {
    return [
        `*${BOT_NAME} is online.*`,
        '',
        OPENROUTER_API_KEY
            ? `Send me questions about Student Finance Wallet and I will answer with AI using the loaded knowledge source.`
            : 'Send me questions about Student Finance Wallet and I will answer from the loaded knowledge source.',
        '',
        'Commands:',
        '- `/start` start the bot',
        '- `/help` show commands',
        '- `/source` show where answers come from',
        '',
        `Current source: ${knowledge.sourceLabel}`,
        OPENROUTER_API_KEY ? `AI model: ${OPENROUTER_MODEL}` : 'AI mode: disabled'
    ].join('\n');
}

async function startBot() {
    await ensureDataDirectories();
    console.log(`Data directory: ${DATA_DIR}`);
    console.log(`Session directory: ${SESSION_DATA_DIR}`);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DATA_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu(BOT_NAME),
        markOnlineOnConnect: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            writeQrArtifacts(qr)
                .then(() => {
                    console.log(`Saved QR files to ${QR_OUTPUT_DIR}`);
                    console.log(`PNG: ${QR_PNG_PATH}`);
                    console.log(`SVG: ${QR_SVG_PATH}`);
                })
                .catch((error) => {
                    console.log(`Failed to write QR files: ${error.message}`);
                });

            if (process.env.GITHUB_ACTIONS !== 'true') {
                console.clear();
                console.log(`\n${BOT_NAME} QR code\n`);
                terminalQR.generate(qr, { small: true });
            } else {
                console.log(`${BOT_NAME} generated a QR code. Download the workflow artifact instead of scanning the log output.`);
            }
        }

        if (connection === 'open') {
            console.log(`${BOT_NAME} is online.`);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`${BOT_NAME} connection closed. Status code: ${reason ?? 'unknown'}`);
            if (lastDisconnect?.error) {
                console.log(`Disconnect error: ${lastDisconnect.error}`);
            }
            if (reason !== DisconnectReason.loggedOut) {
                startBot().catch((error) => console.log(`Restart failed: ${error.message}`));
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (messageEvent) => {
        const message = messageEvent.messages[0];

        if (!message?.message || message.key.remoteJid === 'status@broadcast' || message.key.fromMe) {
            return;
        }

        const sender = message.key.remoteJid;
        const originalText = getMessageText(message.message);
        const text = originalText.toLowerCase();

        if (!text) {
            return;
        }

        console.log(`Incoming from ${sender}: ${originalText}`);
        await appendChatLog({
            timestamp: new Date().toISOString(),
            sender,
            direction: 'incoming',
            text: originalText
        });

        try {
            if (text === '/start') {
                startedUsers.add(sender);
                conversationHistory.delete(sender);
                const knowledge = await loadKnowledge();
                const welcomeText = buildWelcomeMessage(knowledge);
                await sock.sendMessage(sender, { text: welcomeText });
                await appendChatLog({
                    timestamp: new Date().toISOString(),
                    sender,
                    direction: 'outgoing',
                    text: welcomeText
                });
                return;
            }

            if (!startedUsers.has(sender)) {
                const promptText = 'Send `/start` to begin chatting with Anubis.';
                await sock.sendMessage(sender, {
                    text: promptText
                });
                await appendChatLog({
                    timestamp: new Date().toISOString(),
                    sender,
                    direction: 'outgoing',
                    text: promptText
                });
                return;
            }

            if (text === '/help') {
                const knowledge = await loadKnowledge();
                const helpText = buildWelcomeMessage(knowledge);
                await sock.sendMessage(sender, { text: helpText });
                await appendChatLog({
                    timestamp: new Date().toISOString(),
                    sender,
                    direction: 'outgoing',
                    text: helpText
                });
                return;
            }

            if (text === '/source') {
                const knowledge = await loadKnowledge();
                const sourceText = OPENROUTER_API_KEY
                    ? `Anubis is answering with ${OPENROUTER_MODEL} using: ${knowledge.sourceLabel}`
                    : `Anubis is answering from: ${knowledge.sourceLabel}`;
                await sock.sendMessage(sender, {
                    text: sourceText
                });
                await appendChatLog({
                    timestamp: new Date().toISOString(),
                    sender,
                    direction: 'outgoing',
                    text: sourceText
                });
                return;
            }

            if (text === '/refresh') {
                const knowledge = await loadKnowledge(true);
                const refreshText = `Knowledge refreshed.\n\nCurrent source: ${knowledge.sourceLabel}`;
                await sock.sendMessage(sender, {
                    text: refreshText
                });
                await appendChatLog({
                    timestamp: new Date().toISOString(),
                    sender,
                    direction: 'outgoing',
                    text: refreshText
                });
                return;
            }

            if (isGreeting(text)) {
                const greetingText = 'Ask me something about Student Finance Wallet. For example: how to create a payment session, how QR checkout works, or how to check payment status.';
                await sock.sendMessage(sender, {
                    text: greetingText
                });
                await appendChatLog({
                    timestamp: new Date().toISOString(),
                    sender,
                    direction: 'outgoing',
                    text: greetingText
                });
                return;
            }

            const knowledge = await loadKnowledge();
            let answer;

            try {
                answer = await generateAiAnswer(sender, originalText, knowledge);
            } catch (error) {
                console.log(`OpenRouter fallback triggered: ${error.message}`);
                answer = buildAnswer(originalText, knowledge);
            }

            await sock.sendMessage(sender, { text: answer });
            addConversationMessage(sender, 'user', originalText);
            addConversationMessage(sender, 'assistant', answer);
            await appendChatLog({
                timestamp: new Date().toISOString(),
                sender,
                direction: 'outgoing',
                text: answer
            });
        } catch (error) {
            console.error('Message handling error:', error);
            const errorText = 'I hit an error while reading the knowledge source. Try again in a moment or send `/refresh`.';
            await sock.sendMessage(sender, {
                text: errorText
            });
            await appendChatLog({
                timestamp: new Date().toISOString(),
                sender,
                direction: 'outgoing',
                text: errorText
            });
        }
    });
}

startBot().catch((error) => console.log(`Startup error: ${error.message}`));
