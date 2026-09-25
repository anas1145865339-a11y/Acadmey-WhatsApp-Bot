const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestWaWebVersion,
    Browsers,
    DisconnectReason,
    delay,
    jidNormalizedUser,
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const NodeCache = require("node-cache");
const readline = require("readline");
const fs = require("fs");

// استدعاء مكتبة الذكاء الاصطناعي لجوجل
const { GoogleGenAI } = require("@google/genai");

// تم إدراج مفتاح الـ API الخاص بك بنجاح
const ai = new GoogleGenAI({ apiKey: "AIzaSyAr4QY2CmcFY1qgKpXqTROAi8XfLAnxYBk" });

const PREFIX = ".";
const DATA_FILE = "./bot_data.json";

let sock;
let starting = false;

const groupCache = new NodeCache({
    stdTTL: 300,
    useClones: false
});

const defaultBadWords = [
    "احا", "كسم", "عرص", "شراميط", "شرموط", "منيك", "قحبة", "كس", "زب", "طيز"
];

const defaultRules1 = `
📋 قانون 1 | جروب المعلمات
🏫 أكاديمية المتفوقين
حرصًا على تنظيم العمل وتحقيق أفضل تعاون بين فريق الأكاديمية، يرجى الالتزام بالاحترام المتبادل وعدم نشر روابط خارجية أو محتوى خارج إطار العمل.
`;

const defaultRules2 = `
📋 قانون 2 | جروب أولياء الأمور
🏫 أكاديمية المتفوقين
أهلًا بحضراتكم. هذا الجروب مخصص لمتابعة الطلاب والإعلانات الرسمية للأكاديمية. يرجى الالتزام بالذوق العام وعدم إرسال رسائل متكررة.
`;

const autoContentList = [
    `🌸 *صلِ على الحبيب* \n\nاللهم صلِّ وسلم وبارك على نبينا محمد وعلى آله وصحبه أجمين 🖤`,
    `📿 *ذكر مبارك* \n\n"سُبْحَان اللهِ وَبِحَمْدِهِ، عَدَدَ خَلْقِهِ، وَرِضَا نَفْسِهِ، وَزِنَةَ عَرْشِهِ، وَمِدَادَ كَلِمَاتِهِ."`,
    `📖 *حديث نبوي شريف* \n\nعن أبي هريرة رضي الله عنه أن رسول الله ﷺ قال: «مَنْ سَلَكَ طَرِيقًا يَلْتَمِسُ فِيهِ عِلْمًا سَهَّلَ اللَّهُ لَهُ بِهِ طَرِيقًا إِلَى الْجَنَّةِ». (رواه مسلم)`,
    `💡 *حكمة نافعة* \n\n"العلم في الصغر كالنقش على الحجر، واحرص دائماً على أن يكون وقتك معموراً بالنافع."`,
    `🌍 *معلومات عامة* \n\nهل تعلم أن القراءة المنتظمة لمدة 15 دقيقة يومياً تنشط الذاكرة وتوسع مدارك الفهم والتركيز بشكل ملحوظ!`
];

function createDefaultData() {
    return {
        badWords: [...defaultBadWords],
        rules: { "1": defaultRules1, "2": defaultRules2 },
        groups: {}
    };
}

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            const data = createDefaultData();
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
            return data;
        }
        return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch (error) {
        const data = createDefaultData();
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
        return data;
    }
}

let botData = loadData();

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(botData, null, 2), "utf8");
    } catch (error) {}
}

function getGroupSettings(groupId) {
    if (!botData.groups[groupId]) {
        botData.groups[groupId] = {
            rule: "1",
            antiLink: true,
            antiBadWords: true,
            autoBroadcast: true
        };
        saveData();
    }
    return botData.groups[groupId];
}

function normalizeText(text = "") {
    return String(text).toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/\s+/g, " ").trim();
}

function isGroup(jid) {
    return String(jid || "").endsWith("@g.us");
}

function isLink(text = "") {
    return /(https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/|[a-z0-9-]+\.(com|net|org|me|io|app|dev))/i.test(text);
}

function containsBadWord(text = "") {
    const normalized = normalizeText(text);
    return botData.badWords.some(word => normalized.includes(normalizeText(word)));
}

async function safeSend(jid, content) {
    try {
        return await sock.sendMessage(jid, content);
    } catch (error) {
        return null;
    }
}

async function getGroupMetadata(groupId) {
    try {
        const cached = groupCache.get(groupId);
        if (cached) return cached;
        const metadata = await sock.groupMetadata(groupId);
        groupCache.set(groupId, metadata);
        return metadata;
    } catch (error) {
        return null;
    }
}

async function checkPermissions(groupId, sender) {
    const metadata = await getGroupMetadata(groupId);
    if (!metadata) return { isAdmin: false, isBotAdmin: false };
    const senderP = metadata.participants.find(p => p.id === sender || p.jid === sender);
    const botId = sock.user?.id ? jidNormalizedUser(sock.user.id) : "";
    const botP = metadata.participants.find(p => jidNormalizedUser(p.id) === botId || jidNormalizedUser(p.jid) === botId);
    
    const isAdmin = senderP?.admin === "admin" || senderP?.admin === "superadmin";
    const isBotAdmin = botP?.admin === "admin" || botP?.admin === "superadmin";
    return { isAdmin, isBotAdmin };
}

/* =========================================================
   دالة الذكاء الاصطناعي مع معالجة الردود
========================================================= */
async function askAI(userMessage) {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: userMessage,
            config: {
                systemInstruction: "أنت مساعد ذكي رسمي لـ 'أكاديمية المتفوقين'. تجيب على أسئلة الطلاب وأولياء الأمور بلغة عربية فصحى مبسطة، ودودة، ومحترفة. تم تطوير وبرمجة هذا البوت بواسطة المطور أنس أحمد يوسف. إذا كان السؤال يحتاج تدخلاً إدارياً عاجلاً، انصحهم بالانتظار ليتم الرد عليهم في أقرب وقت."
            }
        });
        return response.text;
    } catch (error) {
        return "عذراً، أواجه ضغطاً حالياً. سيتم الرد عليك في أقرب وقت من إدارة الأكاديمية 🌷";
    }
}

/* =========================================================
   النشر التلقائي (كل ساعة)
========================================================= */
function startAutoBroadcastSystem() {
    setInterval(async () => {
        try {
            if (!sock) return;
            const groups = await sock.groupFetchAllParticipating();
            const groupIds = Object.keys(groups || {});
            const randomMsg = autoContentList[Math.floor(Math.random() * autoContentList.length)];
            const finalBroadcast = `🏫 *أكاديمية المتفوقين - نشرة تلقائية* 🌷\n\n${randomMsg}`;

            for (const gId of groupIds) {
                const settings = getGroupSettings(gId);
                if (settings.autoBroadcast) {
                    await safeSend(gId, { text: finalBroadcast });
                    await delay(2000);
                }
            }
        } catch (e) {}
    }, 60 * 60 * 1000);
}

/* =========================================================
   تشغيل البوت والربط
========================================================= */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function startBot() {
    if (starting) return;
    starting = true;

    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestWaWebVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        browser: Browsers.macOS("Chrome")
    });

    if (!sock.authState.creds.registered) {
        console.log("\n📱 أهلاً بك يا أنس. جاري إعداد ربط برقم الواتساب...");
        const phoneNumber = await question("اكتب رقم هاتفك مع رمز الدولة (مثال: 2010xxxxxxxx): ");
        const code = await sock.requestPairingCode(phoneNumber.trim());
        console.log(`\n🔑 كود الربط الخاص بك هو: \x1b[32m${code}\x1b[0m\n`);
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "open") {
            console.log("✅ البوت متصل ومبرمج بواسطة: أنس أحمد يوسف ويعمل بكفاءة تامة!");
            starting = false;
            startAutoBroadcastSystem();
        } else if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            starting = false;
            if (shouldReconnect) setTimeout(startBot, 3000);
        }
    });

    /* =========================================================
       معالجة الرسائل والأوامر والذكاء الاصطناعي مع الأنيميشن
    ========================================================= */
    sock.ev.on("messages.upsert", async (event) => {
        const mek = event.messages[0];
        if (!mek || !mek.message || mek.key.fromMe) return;

        const jid = mek.key.remoteJid;
        const sender = isGroup(jid) ? (mek.key.participant || mek.participant) : jid;
        const text = mek.message.conversation || mek.message.extendedTextMessage?.text || "";
        const normalized = normalizeText(text);

        if (!text) return;

        // 1. نظام الحماية (روابط وألفاظ)
        if (isGroup(jid)) {
            const settings = getGroupSettings(jid);
            const perm = await checkPermissions(jid, sender);

            if (!perm.isAdmin) {
                if (settings.antiLink && isLink(text)) {
                    await sock.sendMessage(jid, { delete: mek.key });
                    await safeSend(jid, { text: `⚠️ @${sender.split("@")[0]} ممنوع نشر الروابط هنا!`, mentions: [sender] });
                    return;
                }
                if (settings.antiBadWords && containsBadWord(text)) {
                    await sock.sendMessage(jid, { delete: mek.key });
                    await safeSend(jid, { text: `⚠️ @${sender.split("@")[0]} عذراً، هذا اللفظ غير مسموح به!`, mentions: [sender] });
                    return;
                }
            }
        }

        // 2. المنيو والأوامر
        if (normalized === ".منيو" || normalized === ".اوامر") {
            const menu = `
╔════════════════════════════╗
      🏫 أكاديمية المتفوقين
          🤖 منيو الأوامر
╚════════════════════════════╝

👨‍💻 *المطور:* أنس أحمد يوسف

📌 *الأوامر المتاحة:*
• .القوانين (لعرض قانون الجروب)
• .المطور (معلومات المطور)
• .بينج (للفحص)

🤖 *الذكاء الاصطناعي:* 
تحدث معي في الخاص أو اعمل لي منشن في الجروب وسأرد عليك فوراً!
`;
            await safeSend(jid, { text: menu });
            return;
        }

        if (normalized === ".المطور") {
            await safeSend(jid, { text: "👨‍💻 تم تطوير وبرمجة هذا البوت بواسطة العبقري: **أنس أحمد يوسف** 🚀" });
            return;
        }

        if (normalized === ".القوانين" || normalized === ".قانون") {
            const targetRuleId = isGroup(jid) ? (getGroupSettings(jid).rule || "1") : "1";
            await safeSend(jid, { text: botData.rules[targetRuleId] });
            return;
        }

        if (normalized === ".بينج") {
            await safeSend(jid, { text: "🚀 البوت يعمل بكفاءة تامة على مدار الساعة!" });
            return;
        }

        // 3. التشغيل الذكي بالذكاء الاصطناعي مع أنيميشن (جاري الكتابة...)
        const botNumber = jidNormalizedUser(sock.user?.id || "");
        const isMentioned = text.includes(`@${botNumber.split("@")[0]}`) || mek.message.extendedTextMessage?.contextInfo?.mentionedJid?.includes(botNumber);

        if (!isGroup(jid) || isMentioned) {
            const cleanQuery = text.replace(/@\d+/g, "").trim();
            if (cleanQuery && !cleanQuery.startsWith(".")) {
                
                // تفعيل أنيميشن "جاري الكتابة..."
                try {
                    await sock.presenceSubscribe(jid);
                    await sock.sendPresenceUpdate('composing', jid);
                } catch (e) {}

                // جلب الرد من الذكاء الاصطناعي
                const aiReply = await askAI(cleanQuery);
                await safeSend(jid, { text: aiReply });
            }
        }
    });
}

startBot();
