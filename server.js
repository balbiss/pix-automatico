import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const VERSION = "V3.002";
const app = express();
app.use(express.json());

// Logger Global
function log(tag, message) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  console.log(`[BOT LOG] [${VERSION}] ${time} - [${tag}] ${message}`);
}

const esc = (text) => {
  if (!text) return "";
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

// Configurações Dinâmicas
let config = {
  PRODUCT_PRICE: process.env.PRODUCT_PRICE || "19.90",
  COMMISSION_L1: process.env.COMMISSION_L1 || "6.00",
  COMMISSION_L2: process.env.COMMISSION_L2 || "3.00",
  ADMIN_ID: "7924857149"
};

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  TELEGRAM_BOT_TOKEN,
  SYNCPAY_CLIENT_ID,
  SYNCPAY_CLIENT_SECRET,
  SYNCPAY_BASE_URL,
  WEBHOOK_URL
} = process.env;

const supabase = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_SERVICE_ROLE_KEY || 'key');
const bot = new Telegraf(TELEGRAM_BOT_TOKEN || '000:dummy');

log('SYSTEM', `Iniciando Telemetria V3.002...`);

// --- LÓGICA SYNCPAY ---
async function getSyncPayToken() {
  try {
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/auth-token`, {
      client_id: SYNCPAY_CLIENT_ID,
      client_secret: SYNCPAY_CLIENT_SECRET
    });
    return response.data.access_token;
  } catch (error) {
    log('ERROR', `Erro Token SyncPay: ${error.message}`);
    throw error;
  }
}

async function createSyncPayCharge(telegramId, amount) {
  const token = await getSyncPayToken();
  const txId = `TX_${telegramId}_${Date.now()}`;
  try {
    const payload = {
      external_id: txId,
      amount: parseFloat(amount),
      description: `Pedido ${telegramId}`,
      webhook_url: WEBHOOK_URL,
      client: {
        name: "Consumidor Final",
        cpf: "12345678909",
        email: "pagamento@botindicacao.com"
      }
    };
    log('DEBUG', `Gerando Pix com ID: ${txId} | URL: ${WEBHOOK_URL}`);
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/cash-in`, payload, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  } catch (error) { throw error; }
}

// --- WEBHOOK (TELEMETRIA TOTAL) ---
app.all('/webhook/syncpay', async (req, res) => {
  log('WEBHOOK_IN', `${req.method} Recebido de ${req.ip}`);
  log('WEBHOOK_DATA', JSON.stringify(req.body));

  const { external_id, status, amount } = req.body;
  if (!external_id) return res.status(400).send('No ID');

  if (['PAID', 'completed', 'success'].includes(status)) {
    try {
      // Tenta extrair ID do formato TX_ID_TIMESTAMP ou usa o ID puro
      let telegramId = external_id.includes('_') ? external_id.split('_')[1] : external_id;

      log('PROCESS', `Confirmando para User: ${telegramId}...`);

      const { data: user } = await supabase.from('usuarios').select('*').eq('telegram_id', telegramId).single();
      if (!user) {
        log('PROCESS', `User ${telegramId} não encontrado no banco.`);
        return res.send('User Not Found');
      }
      if (user.is_active) {
        log('PROCESS', `User ${telegramId} já estava ativo.`);
        return res.send('Already Active');
      }

      await supabase.from('usuarios').update({ is_active: true }).eq('telegram_id', telegramId);

      if (user.padrinho_id) {
        await supabase.rpc('increment_balance', { user_id: user.padrinho_id, amount: parseFloat(config.COMMISSION_L1) });
        if (user.avo_id) {
          await supabase.rpc('increment_balance', { user_id: user.avo_id, amount: parseFloat(config.COMMISSION_L2) });
        }
      }

      await bot.telegram.sendMessage(telegramId, `💎 *PAGAMENTO CONFIRMADO\\!*
      
Sua conta foi ativada e seu E\\-book está sendo enviado abaixo\\.`, { parse_mode: 'MarkdownV2' });

      await bot.telegram.sendDocument(telegramId, { source: './ebook.pdf' }).catch(() => log('ERROR', 'Falha ao enviar arquivo PDF'));

      log('SUCCESS', `User ${telegramId} ativado com sucesso.`);
      return res.send('OK');
    } catch (err) {
      log('ERROR', `Erro Proc. Webhook: ${err.message}`);
    }
  }
  res.send('Aguardando');
});

// --- COMANDOS BOT ---
bot.start(async (ctx) => {
  const tid = ctx.from.id.toString();
  log('BOT_START', `User ${tid}`);
  try {
    const { data: user } = await supabase.from('usuarios').select('*').eq('telegram_id', tid).single();
    if (!user) {
      const sp = ctx.startPayload;
      let p1 = null, p2 = null;
      if (sp && sp !== tid) {
        const { data: p } = await supabase.from('usuarios').select('telegram_id', padrinho_id).eq('telegram_id', sp).single();
        if (p) { p1 = p.telegram_id; p2 = p.padrinho_id; }
      }
      await supabase.from('usuarios').insert([{ telegram_id: tid, padrinho_id: p1, avo_id: p2, saldo: 0, is_active: false }]);
    }
    const menu = getStartMenu();
    ctx.replyWithMarkdownV2(menu.text, { reply_markup: menu.keyboard });
  } catch (e) { log('ERROR', 'Erro Command Start'); }
});

const getStartMenu = () => ({
  text: `🚀 *BEM\\-VINDO AO IMPÉRIO DIGITAL\\!*

💰 *E\\-book:* R$ ${esc(config.PRODUCT_PRICE)}
💎 *Ganhos:* Comissões em 2 níveis\\!

Escolha uma opção:`,
  keyboard: {
    inline_keyboard: [
      [{ text: "💳 COMPRAR E-BOOK", callback_data: "buy_pix" }],
      [{ text: "📊 MEU PAINEL", callback_data: "profile" }]
    ]
  }
});

bot.action('back_to_start', async (ctx) => {
  const menu = getStartMenu();
  await ctx.editMessageText(menu.text, { parse_mode: 'MarkdownV2', reply_markup: menu.keyboard }).catch(() => ctx.answerCbQuery());
});

bot.action('buy_pix', async (ctx) => {
  try {
    await ctx.answerCbQuery("Gerando Pix...");
    const charge = await createSyncPayCharge(ctx.from.id.toString(), config.PRODUCT_PRICE);
    const pixCode = charge.pix_code || charge.pix_copy_and_paste || charge.qrcode;
    const msg = `⚡ *QUASE LÁ\\!*
      
1\\. Copie o código abaixo
2\\. Pague via *Pix Copia e Cola*

\`${esc(pixCode)}\`

_A entrega é automática após pagar\\._`;
    await ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: "⬅️ VOLTAR", callback_data: "back_to_start" }]] }
    });
  } catch (e) { ctx.reply("❌ Erro ao gerar Pix."); }
});

bot.action('profile', async (ctx) => {
  const tid = ctx.from.id.toString();
  try {
    const { data: u } = await supabase.from('usuarios').select('*').eq('telegram_id', tid).single();
    const { count: n1 } = await supabase.from('usuarios').select('*', { count: 'exact', head: true }).eq('padrinho_id', tid);
    const { count: n2 } = await supabase.from('usuarios').select('*', { count: 'exact', head: true }).eq('avo_id', tid);
    const me = await bot.telegram.getMe();
    const DASH = `👤 *SEU PAINEL*

💰 *Saldo:* R$ ${esc(u.saldo.toFixed(2))}
👥 *Rede:* L1: ${esc(n1 || 0)} | L2: ${esc(n2 || 0)}

🔗 *SEU LINK:*
\`https://t.me/${me.username}?start=${tid}\``;
    await ctx.editMessageText(DASH, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [{ text: "💸 SACAR", callback_data: "withdraw" }],
          [{ text: "⬅️ VOLTAR", callback_data: "back_to_start" }]
        ]
      }
    });
  } catch (e) { ctx.answerCbQuery(); }
});

bot.action('withdraw', async (ctx) => {
  await ctx.editMessageText(`🏦 *SAQUE*
Informe seu CPF: \`/sacar SEU_CPF\``, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: [[{ text: "⬅️ CANCELAR", callback_data: "profile" }]] }
  });
});

bot.command('admin', async (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) return;
  const { count: total } = await supabase.from('usuarios').select('*', { count: 'exact', head: true });
  const ADMIN_MSG = `⚙️ *ADMIN* \\| Usuários: ${esc(total)}
💰 Preço: R$ ${esc(config.PRODUCT_PRICE)}
\`/setpreco 19.90\` \\| \`/setcomissao1 6.00\``;
  ctx.replyWithMarkdownV2(ADMIN_MSG);
});

bot.command('setpreco', (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) return;
  const val = ctx.message.text.split(' ')[1];
  if (val) { config.PRODUCT_PRICE = val; ctx.reply(`✅ R$ ${val}`); }
});

bot.command('sacar', async (ctx) => {
  const tid = ctx.from.id.toString();
  const { data: u } = await supabase.from('usuarios').select('saldo').eq('telegram_id', tid).single();
  if (u.saldo < 50) return ctx.reply("❌ Saldo insuficiente.");
  ctx.reply("✅ Saque solicitado!");
});

// Inicialização
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  log('SYSTEM', `Servidor na porta ${PORT} | Webhook: ${WEBHOOK_URL}`);
  try {
    await bot.launch();
    log('SYSTEM', 'Bot Online!');
  } catch (e) { log('ERROR', `Fail: ${e.message}`); }
});
